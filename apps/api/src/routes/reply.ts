import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Email,
  SenderBrand,
  Source,
  Instruction,
  OutboundMessage,
} from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { senderDomainTag } from '@rose/email-parser';
import { userIdOf } from '../middleware/auth.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { sendOutboundQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';
import {
  retrievePages,
  renderContextBlock,
} from '../lib/retrieval.js';

export const replyRouter: Router = Router();

async function loadEmail(id: string, userId: Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) return null;
  return Email.findOne({ _id: id, userId });
}

async function templateFor(userId: Types.ObjectId): Promise<string> {
  const userOverride = await Instruction.findOne({ userId, scope: 'reply', isDefault: true });
  if (userOverride) return userOverride.template;
  const system = await Instruction.findOne({ userId, scope: 'reply', isSystem: true });
  if (system) return system.template;
  return `Draft an email reply.

ORIGINAL EMAIL
- From: {{from}}
- Subject: {{subject}}
- Sent: {{date}}
- Body:
"""
{{body}}
"""

CONTEXT
{{context}}

Reply in plain markdown, no headings.`;
}

async function senderBriefFor(
  _userId: Types.ObjectId,
  fromAddress: string | null | undefined,
): Promise<string> {
  if (!fromAddress) return '(no sender info)';
  const brand = senderDomainTag(fromAddress);
  const brandKey = brand ? brand.toLowerCase() : fromAddress.toLowerCase();
  // Plan 15 — brand-global fields live on SenderBrand. Reply
  // context doesn't need any per-user state, so we read directly
  // from the global row.
  const row = await SenderBrand.findOne({ brandKey })
    .select('name domain summary websites')
    .lean();
  if (!row) return '(no address-book entry yet)';
  const parts = [
    row.name && `Display name: ${row.name}`,
    row.domain && `Domain: ${row.domain}`,
    row.summary && `Summary: ${row.summary}`,
    row.websites?.length && `Websites: ${row.websites.slice(0, 3).join(', ')}`,
  ].filter(Boolean);
  return parts.join('\n') || '(empty entry)';
}

/**
 * Stream a draft reply for the given email. SSE events:
 *   { type: 'citations', citations }
 *   { type: 'token', delta }
 *   { type: 'completed', model, body }   // body is the final text we persisted
 *   { type: 'error', message }
 */
replyRouter.post('/:id/draft-reply', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const email = await loadEmail(req.params.id, userId);
  if (!email) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Retrieve relevant context, exclude the page this email is on (so
  // we don't quote ourselves back at the model).
  const queryText = `${email.subject ?? ''}\n${(email.text ?? '').slice(0, 1500)}`;
  let citations: Record<string, unknown> = {};
  let contextBlock = '(no relevant pages)';
  try {
    const hits = await retrievePages(userId, queryText, {
      limit: 6,
      excludePageId: email.pageId as Types.ObjectId | undefined,
    });
    const r = renderContextBlock(hits, queryText);
    contextBlock = r.text || '(no relevant pages)';
    citations = r.citations;
  } catch (err) {
    logger.warn({ err }, 'reply draft: retrieval failed; continuing context-free');
  }
  send({ type: 'citations', citations });

  const senderBrief = await senderBriefFor(userId, email.from?.address);
  const template = await templateFor(userId);
  const userDoc = await (await import('@rose/db')).User.findById(userId)
    .select('displayName')
    .lean();
  const prompt = renderTemplate(template, {
    user_display_name: userDoc?.displayName ?? '',
    from: email.from?.address ?? 'unknown',
    subject: email.subject ?? '(no subject)',
    date: email.date ? new Date(email.date).toISOString() : '(unknown)',
    body: (email.text ?? '').slice(0, 8000),
    context: contextBlock,
    sender_brief: senderBrief,
  });

  let providerInfo;
  try {
    providerInfo = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
    res.end();
    return;
  }
  const { provider, model: genModel, providerId } = providerInfo;
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  let buffered = '';
  try {
    for await (const chunk of provider.generateStream({
      model: genModel,
      prompt,
      system: SYSTEM_PROMPT_BASE,
      temperature: 0.4,
    })) {
      if (chunk.response) {
        buffered += chunk.response;
        send({ type: 'token', delta: chunk.response });
      }
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
    res.end();
    return;
  }

  // Persist the draft so reload doesn't lose it.
  email.draftReply = buffered.trim();
  email.set('draftReplyMeta', {
    model: `${providerId}:${genModel}`,
    generatedAt: new Date(),
    edits: ((email.draftReplyMeta?.edits ?? 0) as number) + 1,
  });
  await email.save();

  send({
    type: 'completed',
    model: `${providerId}:${genModel}`,
    body: buffered.trim(),
  });
  res.end();
});

/** Save a hand-edited draft. */
replyRouter.post('/:id/draft-reply/save', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const email = await loadEmail(req.params.id, userId);
  if (!email) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = (req.body ?? {}) as { draft?: string };
  email.draftReply = (body.draft ?? '').slice(0, 50_000);
  email.set('draftReplyMeta', {
    ...(email.draftReplyMeta ?? {}),
    edits: ((email.draftReplyMeta?.edits ?? 0) as number) + 1,
  });
  await email.save();
  res.json({ ok: true });
});

replyRouter.delete('/:id/draft-reply', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const email = await loadEmail(req.params.id, userId);
  if (!email) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  email.draftReply = null;
  email.set('draftReplyMeta', { model: null, generatedAt: null, edits: 0 });
  await email.save();
  res.json({ ok: true });
});

// ── Outbound CRUD ─────────────────────────────────────────────────────

export const outboundRouter: Router = Router();

/** Pick the source we'll send through. The user can override; default
 *  to the first matching active source for the inbound email. */
async function pickTransport(
  userId: Types.ObjectId,
  hint: { sourceId?: string; transport?: 'smtp' | 'gmail' },
): Promise<{ sourceId: Types.ObjectId; transport: 'smtp' | 'gmail' } | null> {
  if (hint.sourceId && Types.ObjectId.isValid(hint.sourceId)) {
    const src = await Source.findOne({ _id: hint.sourceId, userId, status: 'active' });
    if (src) {
      const transport: 'smtp' | 'gmail' = src.type === 'gmail' ? 'gmail' : 'smtp';
      return { sourceId: src._id as Types.ObjectId, transport };
    }
  }
  // Auto-pick: prefer Gmail (cleaner deliverability), then any IMAP.
  const gmail = await Source.findOne({ userId, type: 'gmail', status: 'active' });
  if (gmail) return { sourceId: gmail._id as Types.ObjectId, transport: 'gmail' };
  const imap = await Source.findOne({ userId, type: 'imap', status: 'active' });
  if (imap) return { sourceId: imap._id as Types.ObjectId, transport: 'smtp' };
  return null;
}

outboundRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    inReplyToEmailId?: string;
    to?: { name?: string; address: string }[];
    cc?: { name?: string; address: string }[];
    bcc?: { name?: string; address: string }[];
    subject?: string;
    bodyMd?: string;
    sourceId?: string;
    transport?: 'smtp' | 'gmail';
  };
  if (!body.to?.length) {
    res.status(400).json({ error: 'invalid_request', message: 'At least one recipient required' });
    return;
  }
  if (!body.bodyMd?.trim()) {
    res.status(400).json({ error: 'invalid_request', message: 'Body required' });
    return;
  }
  const transport = await pickTransport(userId, body);
  if (!transport) {
    res.status(400).json({
      error: 'no_transport',
      message:
        'No active outbound source configured. Connect IMAP (with SMTP) or Gmail OAuth in Settings → Sources.',
    });
    return;
  }
  // Lazy-import the renderer so the API process doesn't load nodemailer
  // at boot just to get the html-renderer helper.
  const { mdToHtml } = await import('../lib/mdToHtml.js');
  const out = await OutboundMessage.create({
    userId,
    inReplyToEmailId:
      body.inReplyToEmailId && Types.ObjectId.isValid(body.inReplyToEmailId)
        ? new Types.ObjectId(body.inReplyToEmailId)
        : null,
    sourceId: transport.sourceId,
    transport: transport.transport,
    to: body.to,
    cc: body.cc ?? [],
    bcc: body.bcc ?? [],
    subject: (body.subject ?? '').slice(0, 998),
    bodyMd: body.bodyMd,
    bodyHtml: mdToHtml(body.bodyMd),
    status: 'queued',
  });
  await sendOutboundQueue.add(
    'send',
    { outboundId: String(out._id), userId: String(userId) },
    { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  );
  res.status(202).json({ outboundId: String(out._id) });
});

outboundRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const inReplyTo = req.query.inReplyToEmailId as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (inReplyTo && Types.ObjectId.isValid(inReplyTo)) {
    filter.inReplyToEmailId = new Types.ObjectId(inReplyTo);
  }
  const outbound = await OutboundMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(50)
    .select('-bodyHtml')
    .lean();
  res.json({ outbound });
});

outboundRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const out = await OutboundMessage.findOne({ _id: req.params.id, userId }).lean();
  if (!out) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(out);
});
