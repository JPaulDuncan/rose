import { Router } from 'express';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { SourceCreateRequest } from '@rose/shared';
import type { AuthedRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Source } from '@rose/db';
import { ApiToken } from '@rose/db';
import { encryptJson } from '../lib/crypto.js';
import { imapSyncQueue, gmailSyncQueue } from '../lib/queues.js';

export const sourcesRouter = Router();

sourcesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId((req as AuthedRequest).userId);
  const sources = await Source.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ sources });
});

sourcesRouter.post('/', validateBody(SourceCreateRequest), async (req, res) => {
  const userId = new Types.ObjectId((req as AuthedRequest).userId);
  const body = req.body as typeof SourceCreateRequest._type;

  if (body.type === 'imap') {
    const src = await Source.create({
      userId,
      type: 'imap',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
    });
    await imapSyncQueue.add(
      'sync',
      { sourceId: src._id.toString(), userId: userId.toString() },
      {
        repeat: { every: body.config.pollIntervalMinutes * 60_000 },
        jobId: `imap:${src._id.toString()}`,
      },
    );
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
    await gmailSyncQueue.add(
      'sync',
      { sourceId: src._id.toString(), userId: userId.toString() },
      { repeat: { every: 5 * 60_000 }, jobId: `gmail:${src._id.toString()}` },
    );
    res.status(201).json(src);
    return;
  }
});

sourcesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId((req as AuthedRequest).userId);
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
