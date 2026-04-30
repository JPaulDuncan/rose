import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { generatePageQueue, generatePageEvents } from '../lib/queues.js';
import { jobEvents } from '../services/sse.js';
import { env } from '../lib/env.js';
import { userIdOf } from '../middleware/auth.js';

/** Authenticated REST routes. */
export const jobsRouter: Router = Router();

jobsRouter.get('/:id', async (req, res) => {
  const _userId = userIdOf(req);
  void _userId;
  const job = await generatePageQueue.getJob(req.params.id ?? '');
  if (!job) {
    res.status(404).json({ error: 'not_found', message: 'Job not found' });
    return;
  }
  const state = await job.getState();
  res.json({ id: job.id, state, progress: job.progress, returnvalue: job.returnvalue });
});

/**
 * Public-mounted SSE stream that authenticates via either Authorization header
 * or `?access_token=` query (for EventSource which can't send headers).
 */
export const jobsStreamRouter: Router = Router();

jobsStreamRouter.get('/:id/stream', async (req: Request, res: Response) => {
  const header = req.headers.authorization ?? '';
  const token =
    (header.startsWith('Bearer ') ? header.slice(7) : null) ??
    ((req.query.access_token as string | undefined) ?? null);
  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing access token' });
    return;
  }
  try {
    jwt.verify(token, env.JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }
  const jobId = req.params.id ?? '';
  if (!jobId) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing job id' });
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
  send({ type: 'connected', jobId });

  const onEvent = (ev: unknown) => send(ev);
  jobEvents.on(jobId, onEvent);

  const onCompleted = ({ jobId: id, returnvalue }: { jobId: string; returnvalue?: unknown }) => {
    if (id !== jobId) return;
    send({ type: 'completed', jobId, returnvalue });
    cleanup();
  };
  const onFailed = ({ jobId: id, failedReason }: { jobId: string; failedReason?: string }) => {
    if (id !== jobId) return;
    send({ type: 'failed', jobId, error: failedReason ?? 'unknown' });
    cleanup();
  };
  generatePageEvents.on('completed', onCompleted);
  generatePageEvents.on('failed', onFailed);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    jobEvents.off(jobId, onEvent);
    generatePageEvents.off('completed', onCompleted);
    generatePageEvents.off('failed', onFailed);
    res.end();
  };

  req.on('close', cleanup);
});
