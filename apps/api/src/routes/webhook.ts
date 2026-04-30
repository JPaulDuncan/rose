import { Router } from 'express';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { ApiToken } from '@rose/db';
import { Source } from '@rose/db';
import { ingestRawEmail } from '../services/ingest.js';
import { webhookLimiter } from '../middleware/rateLimit.js';

export const webhookRouter: Router = Router();

/**
 * Inbound email webhook. Accepts raw RFC822 (text/plain or message/rfc822) up to ~25MB.
 * Auth via "Authorization: Bearer <token>" tied to a webhook source.
 */
webhookRouter.post('/email', webhookLimiter, async (req, res, next) => {
  try {
    const header = (req.headers.authorization ?? '') as string;
    const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!raw) {
      res.status(401).json({ error: 'unauthorized', message: 'Missing webhook token' });
      return;
    }
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const token = await ApiToken.findOne({ tokenHash });
    if (!token) {
      res.status(401).json({ error: 'unauthorized', message: 'Unknown webhook token' });
      return;
    }
    const source = token.sourceId ? await Source.findById(token.sourceId) : null;
    if (!source || source.status !== 'active') {
      res.status(400).json({ error: 'invalid_request', message: 'Webhook source not active' });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    if (!buf.length) {
      res.status(400).json({ error: 'invalid_request', message: 'Empty body' });
      return;
    }
    const result = await ingestRawEmail({
      userId: new Types.ObjectId(token.userId.toString()),
      sourceId: source._id,
      raw: buf,
    });
    token.lastUsedAt = new Date();
    await token.save();
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
