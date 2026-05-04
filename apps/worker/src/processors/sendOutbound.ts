import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import {
  OutboundMessage,
  Source,
  User,
  type OutboundMessageDoc,
} from '@rose/db';
import { decryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import type { ImapConfig } from '@rose/shared';

const QUEUE = 'rose.send-outbound';

type SendJobData = { outboundId: string; userId: string };

/** Tiny markdown→HTML pass for outbound bodies. We deliberately keep
 *  this minimal — the user composes in markdown so a few common
 *  conversions cover the vast majority of cases. Keeps the binary
 *  small (no markdown-it / sanitiser dependency in the send path). */
function mdToHtml(md: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${escape(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    let html = escape(line);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    out.push(`<p>${html}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;line-height:1.5;">${out.join('\n')}</div>`;
}

/** Pull the SMTP config for an IMAP source. Defaults: smtp.<host>:465
 *  secure when nothing's overridden. */
function smtpConfigFor(source: { smtpHost?: string | null; smtpPort?: number | null; smtpSecure?: boolean | null }, imap: ImapConfig) {
  const host = source.smtpHost ?? imap.host.replace(/^imap\./i, 'smtp.');
  const port = source.smtpPort ?? 465;
  const secure = source.smtpSecure ?? port === 465;
  return { host, port, secure };
}

async function sendViaSmtp(out: OutboundMessageDoc): Promise<{ messageId: string | null }> {
  if (!out.sourceId) throw new Error('SMTP send requires a source');
  const source = await Source.findById(out.sourceId).select('+encryptedConfig');
  if (!source || source.type !== 'imap' || !source.encryptedConfig) {
    throw new Error('SMTP source not found or missing credentials');
  }
  const imap = decryptJson<ImapConfig>(source.encryptedConfig);
  const smtp = smtpConfigFor(source, imap);

  const user = await User.findById(out.userId).select('email displayName').lean();
  const fromName = source.fromName ?? user?.displayName ?? '';
  const fromAddress = imap.username || user?.email || '';

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: imap.username, pass: imap.password },
  });
  const info = await transporter.sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '\\"')}" <${fromAddress}>` : fromAddress,
    to: out.to.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    cc: out.cc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    bcc: out.bcc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)),
    subject: out.subject,
    text: out.bodyMd,
    html: out.bodyHtml,
  });
  return { messageId: info.messageId ?? null };
}

async function sendViaGmail(out: OutboundMessageDoc): Promise<{ messageId: string | null }> {
  if (!out.sourceId) throw new Error('Gmail send requires a source');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Gmail OAuth credentials not configured');
  }
  const source = await Source.findById(out.sourceId).select('+encryptedConfig');
  if (!source || source.type !== 'gmail' || !source.encryptedConfig) {
    throw new Error('Gmail source not found or missing credentials');
  }
  const stored = decryptJson<{ refreshToken?: string }>(source.encryptedConfig);
  const oauth2 = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: stored.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const user = await User.findById(out.userId).select('email displayName').lean();
  const fromName = source.fromName ?? user?.displayName ?? '';
  const fromAddress = user?.email ?? '';

  // Build a multipart/alternative RFC822 message and base64url it.
  const boundary = `rose_${Math.random().toString(36).slice(2)}`;
  const headers: string[] = [
    `From: ${fromName ? `"${fromName.replace(/"/g, '\\"')}" <${fromAddress}>` : fromAddress}`,
    `To: ${out.to.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ')}`,
  ];
  if (out.cc.length)
    headers.push(`Cc: ${out.cc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ')}`);
  if (out.bcc.length)
    headers.push(`Bcc: ${out.bcc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ')}`);
  headers.push(`Subject: ${out.subject}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    out.bodyMd,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    out.bodyHtml,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const raw = Buffer.from(headers.join('\r\n') + '\r\n' + body, 'utf8').toString('base64url');
  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return { messageId: result.data.id ?? null };
}

export function startSendOutboundWorker() {
  const worker = new Worker<SendJobData>(
    QUEUE,
    async (job: Job<SendJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const out = await OutboundMessage.findOne({ _id: job.data.outboundId, userId });
      if (!out) return;
      try {
        const result =
          out.transport === 'gmail' ? await sendViaGmail(out) : await sendViaSmtp(out);
        out.status = 'sent';
        out.sentAt = new Date();
        out.messageId = result.messageId;
        out.error = null;
        await out.save();
        logger.info(
          { outboundId: String(out._id), transport: out.transport },
          'send-outbound: sent',
        );
      } catch (err) {
        out.status = 'failed';
        out.error = (err as Error).message;
        await out.save();
        throw err;
      }
    },
    { connection: redis, concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'send-outbound failed'),
  );
  return worker;
}

/** Exposed so the API route can render bodies the same way the
 *  worker will when it sends. Keeps preview === reality. */
export { mdToHtml };
