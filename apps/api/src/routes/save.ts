import { Router } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import { fetchAndParseQueue } from '../lib/queues.js';

export const saveRouter: Router = Router();

const ALLOWED_DOC_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/html',
]);

// In-memory storage: small enough at 25MB cap, keeps the bytes from
// hitting disk on the API process — they ride directly into the
// worker queue payload (base64).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/**
 * Save an arbitrary URL into the wiki. Returns immediately with a
 * `jobId`; the actual fetch + readability + ingest happens in the
 * worker, with SSRF guards.
 */
saveRouter.post('/url', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as { url?: string; tags?: string[]; note?: string };
  const url = (body.url ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'invalid_request', message: 'Valid URL required' });
    return;
  }
  const job = await fetchAndParseQueue.add(
    'save-url',
    {
      kind: 'url',
      userId: String(userId),
      url,
      tags: body.tags ?? [],
      note: body.note,
    },
    { attempts: 2, removeOnComplete: 100, removeOnFail: 100 },
  );
  res.status(202).json({ jobId: job.id, url });
});

/**
 * Upload a single document. The file rides into the worker queue
 * base64-encoded so we don't need shared disk between processes.
 * Limit to 25MB; worker enforces additional per-format guards.
 */
saveRouter.post('/file', upload.single('file'), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'invalid_request', message: 'No file uploaded' });
    return;
  }
  // Don't trust the client's Content-Type — multer captures it but
  // we still gate against an allow-list.
  const ct = file.mimetype.toLowerCase();
  const allowed =
    ALLOWED_DOC_TYPES.has(ct) ||
    /\.(pdf|docx|md|markdown|txt|html?)$/i.test(file.originalname);
  if (!allowed) {
    res.status(400).json({
      error: 'invalid_request',
      message: `Unsupported file type: ${ct}. Allowed: PDF, DOCX, Markdown, plaintext, HTML.`,
    });
    return;
  }
  const tagsRaw = (req.body?.tags ?? '') as string;
  const tags = tagsRaw
    .split(/[,;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const job = await fetchAndParseQueue.add(
    'save-file',
    {
      kind: 'document',
      userId: String(userId),
      filename: file.originalname,
      contentType: ct,
      bytesBase64: file.buffer.toString('base64'),
      tags,
      note: req.body?.note,
    },
    { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  );
  res.status(202).json({
    jobId: job.id,
    filename: file.originalname,
    size: file.size,
  });
});
