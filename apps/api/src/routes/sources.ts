import { Router } from 'express';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { SourceCreateRequest } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Source } from '@rose/db';
import { ApiToken } from '@rose/db';
import { encryptJson } from '../lib/crypto.js';
import { imapSyncQueue, gmailSyncQueue } from '../lib/queues.js';

export const sourcesRouter: Router = Router();

sourcesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sources = await Source.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ sources });
});

sourcesRouter.post('/', validateBody(SourceCreateRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof SourceCreateRequest._type;

  if (body.type === 'imap') {
    const src = await Source.create({
      userId,
      type: 'imap',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    // Repeatable job fires every N minutes starting at +N — kick off an
    // immediate one-shot so the user doesn't wait for the first interval.
    await imapSyncQueue.add('sync', payload, {
      repeat: { every: body.config.pollIntervalMinutes * 60_000 },
      jobId: `imap:${src._id.toString()}`,
    });
    await imapSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'webhook') {
    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const src = await Source.create({ userId, type: 'webhook', name: body.name });
    await ApiToken.create({ userId, name: body.name, tokenHash, sourceId: src._id });
    res.status(201).json({
      source: src,
      token: rawToken,
      hint: 'Save this token. POST raw RFC822 to /api/webhook/email with header "Authorization: Bearer <token>".',
    });
    return;
  }

  if (body.type === 'gmail') {
    const src = await Source.create({
      userId,
      type: 'gmail',
      name: body.name,
      encryptedConfig: encryptJson({ authCode: body.authCode }),
      status: 'active',
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await gmailSyncQueue.add('sync', payload, {
      repeat: { every: 5 * 60_000 },
      jobId: `gmail:${src._id.toString()}`,
    });
    await gmailSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }
});

/** Force an immediate one-shot sync for an IMAP or Gmail source. */
sourcesRouter.post('/:id/sync', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId });
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Source not found' });
    return;
  }
  const payload = { sourceId: src._id.toString(), userId: userId.toString() };
  const opts = { attempts: 3, removeOnComplete: 50, removeOnFail: 50 } as const;
  if (src.type === 'imap') {
    const job = await imapSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'gmail') {
    const job = await gmailSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  res.status(400).json({
    error: 'invalid_request',
    message: `Source type "${src.type}" does not support manual sync`,
  });
});

sourcesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId });
  if (!src) {
    res.json({ ok: true });
    return;
  }
  if (src.type === 'imap')
    await imapSyncQueue.removeRepeatableByKey(`imap:${src._id.toString()}`).catch(() => null);
  if (src.type === 'gmail')
    await gmailSyncQueue.removeRepeatableByKey(`gmail:${src._id.toString()}`).catch(() => null);
  await ApiToken.deleteMany({ sourceId: src._id });
  await src.deleteOne();
  res.json({ ok: true });
});
