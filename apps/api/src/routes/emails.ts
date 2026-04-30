import { Router } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import { Email } from '@rose/db';
import { ingestRawEmail } from '../services/ingest.js';

export const emailsRouter: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

emailsRouter.post('/upload', upload.array('files', 50), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const files = (req.files ?? []) as Express.Multer.File[];
  if (!files.length) {
    res.status(400).json({ error: 'invalid_request', message: 'No files uploaded' });
    return;
  }
  const results = [];
  for (const f of files) {
    try {
      const r = await ingestRawEmail({ userId, raw: f.buffer });
      results.push({ filename: f.originalname, ...r });
    } catch (err) {
      results.push({
        filename: f.originalname,
        kind: 'failed',
        error: (err as Error).message,
      });
    }
  }
  res.status(201).json({ results });
});

emailsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const status = (req.query.status as string | undefined) ?? undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const filter: Record<string, unknown> = { userId };
  if (status) filter.ingestStatus = status;
  const emails = await Email.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-rawText -html -attachments')
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
