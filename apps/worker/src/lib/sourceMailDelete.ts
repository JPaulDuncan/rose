import { ImapFlow } from 'imapflow';
import { google } from 'googleapis';
import { Source, type SourceDoc } from '@rose/db';
import type { ImapConfig } from '@rose/shared';
import { decryptJson } from './crypto.js';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Best-effort upstream delete for an ingested email. Mirrors the API
 * route at POST /api/emails/:id/delete-on-source so the recipe
 * dispatcher can perform the same upstream cleanup without a round
 * trip through HTTP. Returns whether the source-side delete succeeded
 * — the caller decides what to do with the local Email row.
 */
export async function deleteOnSource(
  sourceId: unknown,
  messageId: string | null,
): Promise<{ deletedOnSource: boolean; reason?: string }> {
  if (!sourceId || !messageId) {
    return { deletedOnSource: false, reason: 'no source or message-id' };
  }
  const source = (await Source.findById(sourceId).select('+encryptedConfig')) as
    | (SourceDoc & { encryptedConfig?: string | null })
    | null;
  if (!source || !source.encryptedConfig) {
    return { deletedOnSource: false, reason: 'source not connected' };
  }
  if (source.type === 'imap') {
    const cfg = decryptJson<ImapConfig>(source.encryptedConfig);
    const ok = await deleteFromImap(cfg, messageId);
    return { deletedOnSource: ok, reason: ok ? undefined : 'message not found in IMAP' };
  }
  if (source.type === 'gmail') {
    return await deleteFromGmail(source.encryptedConfig, messageId);
  }
  return { deletedOnSource: false, reason: `source kind ${source.type} not deletable` };
}

async function deleteFromImap(cfg: ImapConfig, messageId: string): Promise<boolean> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    socketTimeout: 8000,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const wrapped = messageId.startsWith('<') ? messageId : `<${messageId}>`;
      const uids = (await client.search({
        header: { 'message-id': wrapped },
      })) as number[];
      if (!uids || uids.length === 0) return false;
      const trashCandidates = ['[Gmail]/Trash', 'Trash', 'INBOX/Trash', 'Deleted Items'];
      let moved = false;
      for (const dest of trashCandidates) {
        try {
          await client.messageMove(uids, dest, { uid: true });
          moved = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!moved) {
        await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
      }
      return true;
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.warn({ err, host: cfg.host }, 'recipe imap delete failed');
    return false;
  } finally {
    await client.logout().catch(() => null);
  }
}

type GmailStored = { authCode?: string; refreshToken?: string };
async function deleteFromGmail(
  encryptedConfig: string,
  messageId: string,
): Promise<{ deletedOnSource: boolean; reason?: string }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { deletedOnSource: false, reason: 'gmail oauth not configured' };
  }
  try {
    const stored = decryptJson<GmailStored>(encryptedConfig);
    if (!stored.refreshToken) {
      return { deletedOnSource: false, reason: 'gmail not yet authorized' };
    }
    const oauth2 = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
    oauth2.setCredentials({ refresh_token: stored.refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const wrapped = messageId.startsWith('<') ? messageId : `<${messageId}>`;
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `rfc822msgid:${wrapped}`,
      maxResults: 1,
    });
    const m = list.data.messages?.[0];
    if (!m?.id) return { deletedOnSource: false, reason: 'message not found in Gmail' };
    await gmail.users.messages.trash({ userId: 'me', id: m.id });
    return { deletedOnSource: true };
  } catch (err) {
    logger.warn({ err }, 'recipe gmail delete failed');
    return { deletedOnSource: false, reason: (err as Error).message };
  }
}
