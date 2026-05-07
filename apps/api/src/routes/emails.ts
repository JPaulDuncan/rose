import { Router } from 'express';
import { Types } from 'mongoose';
import { ImapFlow } from 'imapflow';
import { google } from 'googleapis';
import { userIdOf } from '../middleware/auth.js';
import { Email, Page, Source } from '@rose/db';
import type { ImapConfig } from '@rose/shared';
import { generatePageQueue } from '../lib/queues.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export const emailsRouter: Router = Router();

emailsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const status = (req.query.status as string | undefined) ?? undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  // `archived=1` returns only archived emails, `all=1` returns both.
  // Default scope is "active" so the recipe-side archive action hides
  // matching emails from the ingest queue without losing them.
  const archived = req.query.archived === '1';
  const includeAll = req.query.all === '1';
  const filter: Record<string, unknown> = { userId };
  if (status) filter.ingestStatus = status;
  if (archived) filter.archivedAt = { $ne: null };
  else if (!includeAll) filter.archivedAt = null;
  const emails = await Email.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-rawText -html -attachments')
    .lean();

  const pageIds = emails
    .map((e) => e.pageId)
    .filter((id): id is Types.ObjectId => !!id);
  const slugMap = new Map<string, string>();
  if (pageIds.length) {
    const pages = await Page.find({ _id: { $in: pageIds }, userId })
      .select('_id slug')
      .lean();
    for (const p of pages) slugMap.set(String(p._id), p.slug);
  }
  const enriched = emails.map((e) => ({
    ...e,
    pageSlug: e.pageId ? slugMap.get(String(e.pageId)) ?? null : null,
  }));
  res.json({ emails: enriched });
});

/**
 * Batch lookup so the page view can resolve sourceEmailIds → metadata in
 * one round trip. Returns at most 200 rows; ids that don't belong to the
 * caller or don't exist are silently dropped.
 */
emailsRouter.post('/by-ids', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const ids = ((req.body as { ids?: unknown })?.ids ?? []) as unknown[];
  const valid = ids
    .filter((x): x is string => typeof x === 'string' && Types.ObjectId.isValid(x))
    .slice(0, 200);
  if (!valid.length) {
    res.json({ emails: [] });
    return;
  }
  const emails = await Email.find({ userId, _id: { $in: valid } })
    .select('_id subject from date pageId ingestStatus')
    .lean();
  res.json({ emails });
});

emailsRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const email = await Email.findOne({ _id: req.params.id, userId }).lean();
  if (!email) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  res.json(email);
});

emailsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Email.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

/**
 * Delete the message from the upstream mail source it came from
 * (IMAP, including Gmail-via-app-password, or Gmail OAuth). Falls
 * back to local-only delete when the source is gone or is a kind
 * we can't reach (webhook, RSS, website, etc.).
 *
 * Returns `{deletedOnSource: bool, message?: string}` so the UI can
 * surface "removed locally only — couldn't reach IMAP" without a
 * 500.
 */
emailsRouter.post('/:id/delete-on-source', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
      return;
    }
    const email = await Email.findOne({ _id: req.params.id, userId }).lean();
    if (!email) {
      res.status(404).json({ error: 'not_found', message: 'Email not found' });
      return;
    }

    let deletedOnSource = false;
    let sourceMessage: string | undefined;

    if (email.sourceId) {
      const source = await Source.findOne({ _id: email.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (source && source.encryptedConfig) {
        if (source.type === 'imap' && email.messageId) {
          deletedOnSource = await deleteFromImap(
            decryptJson<ImapConfig>(source.encryptedConfig),
            email.messageId,
          );
          if (!deletedOnSource) {
            sourceMessage = 'Could not find the message in the IMAP mailbox.';
          }
        } else if (source.type === 'gmail' && email.messageId) {
          const result = await deleteFromGmail(source, email.messageId);
          deletedOnSource = result.ok;
          sourceMessage = result.message;
        } else {
          sourceMessage = `Source kind "${source.type}" can't be deleted on the source.`;
        }
      } else {
        sourceMessage = 'Source no longer connected; deleted locally only.';
      }
    } else {
      sourceMessage = 'No upstream source for this email; deleted locally only.';
    }

    await Email.deleteOne({ _id: req.params.id, userId });
    res.json({ ok: true, deletedOnSource, message: sourceMessage });
  } catch (err) {
    next(err);
  }
});

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
      // IMAP `header` search matches Message-ID headers exactly,
      // including the angle brackets.
      const wrapped = messageId.startsWith('<') ? messageId : `<${messageId}>`;
      const uids = (await client.search({
        header: { 'message-id': wrapped },
      })) as number[];
      if (!uids || uids.length === 0) return false;
      // Move to Trash where possible (Gmail's [Gmail]/Trash, generic
      // "Trash"); fall back to setting the \Deleted flag + expunge so
      // the message at least disappears from the user's view.
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
    logger.warn({ err, host: cfg.host }, 'imap delete-on-source failed');
    return false;
  } finally {
    await client.logout().catch(() => null);
  }
}

type GmailStored = { authCode?: string; refreshToken?: string };
async function deleteFromGmail(
  source: { encryptedConfig?: string | null },
  messageId: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, message: 'Gmail OAuth not configured on this server.' };
  }
  const cfg = source.encryptedConfig;
  if (!cfg) return { ok: false, message: 'Gmail source not connected.' };
  try {
    const stored = decryptJson<GmailStored>(cfg);
    if (!stored.refreshToken) return { ok: false, message: 'Gmail not yet authorized.' };
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
    if (!m?.id) return { ok: false, message: 'Message not found in Gmail.' };
    // `trash` is recoverable; `delete` is permanent. Use trash so the
    // user can restore from Gmail's trash if they change their mind.
    await gmail.users.messages.trash({ userId: 'me', id: m.id });
    void encryptJson; // silence lint when refresh_token didn't rotate
    return { ok: true };
  } catch (err) {
    logger.warn({ err }, 'gmail delete-on-source failed');
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Re-enqueue page generation for an email. Useful when the original job
 * failed (Ollama not running, model not pulled, etc.) and the email is
 * stuck in `parsed`.
 */
emailsRouter.post('/:id/regenerate', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const email = await Email.findOne({ _id: req.params.id, userId });
  if (!email) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  email.ingestStatus = 'parsed';
  email.error = null;
  await email.save();
  const job = await generatePageQueue.add(
    'generate',
    { emailId: email._id.toString(), userId: userId.toString() },
    { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
  );
  res.status(202).json({ jobId: job.id });
});

/**
 * Bulk re-enqueue every email currently stuck at `parsed`. Bounded to keep
 * the user from accidentally creating thousands of jobs at once.
 */
emailsRouter.post('/regenerate-stuck', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number((req.body as { limit?: number })?.limit ?? 500), 5000);
  const stuck = await Email.find({ userId, ingestStatus: 'parsed' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('_id')
    .lean();
  for (const e of stuck) {
    await generatePageQueue.add(
      'generate',
      { emailId: String(e._id), userId: userId.toString() },
      { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
    );
  }
  res.status(202).json({ enqueued: stuck.length });
});

/**
 * History of generate-page jobs targeted at this email — across all
 * BullMQ states (failed/completed/active/waiting/delayed). Returns
 * each job's failedReason + full stacktrace so the user can see
 * exactly why generation didn't produce a page. Powers the "Why
 * didn't this generate?" panel on the inbox row.
 *
 * Bounded scan: BullMQ doesn't index by job-data, so we pull the most
 * recent N jobs per state and filter by emailId in-process. Practical
 * since pages-per-email is small.
 */
emailsRouter.get('/:id/jobs', async (req, res) => {
  const userId = String(userIdOf(req));
  const emailId = req.params.id ?? '';
  if (!emailId) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing email id' });
    return;
  }
  // Confirm the email belongs to this user before scanning the queue —
  // otherwise we'd leak job metadata across accounts.
  const owns = await Email.exists({
    _id: new Types.ObjectId(emailId),
    userId: new Types.ObjectId(userId),
  });
  if (!owns) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  const states = ['failed', 'completed', 'active', 'waiting', 'delayed'] as const;
  const buckets = await Promise.all(
    states.map(async (s) => {
      const jobs = await generatePageQueue.getJobs([s], 0, 200);
      return jobs
        .filter((j) => {
          const d = j.data as { emailId?: string; userId?: string };
          return d?.emailId === emailId && d?.userId === userId;
        })
        .map((j) => ({
          id: j.id,
          state: s as string,
          attemptsMade: j.attemptsMade,
          timestamp: j.timestamp,
          processedOn: j.processedOn ?? null,
          finishedOn: j.finishedOn ?? null,
          failedReason: j.failedReason ?? null,
          stacktrace: j.stacktrace ?? [],
          returnvalue: j.returnvalue ?? null,
        }));
    }),
  );
  const jobs = buckets.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  res.json({ jobs });
});
