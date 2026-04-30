import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { OllamaProvider } from '@rose/llm';
import {
  generatePageQueue,
  generatePageEvents,
  embedPageQueue,
  imapSyncQueue,
} from '../lib/queues.js';
import { jobEvents } from '../services/sse.js';
import { env } from '../lib/env.js';
import { userIdOf } from '../middleware/auth.js';
import { resolveProviderForUser } from '../lib/providers.js';

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
 * Aggregate queue health and per-user provider readiness for the diagnostic
 * banner. Reports model availability against the user's *configured*
 * generation/embedding providers — only fetches Ollama tags when at least
 * one role is configured to use Ollama.
 */
jobsRouter.get('/health/summary', async (req, res) => {
  const userId = userIdOf(req);
  const [genCounts, embedCounts, imapCounts] = await Promise.all([
    generatePageQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    embedPageQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    imapSyncQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
  ]);

  let gen: { providerId: string; model: string; ok: boolean; message?: string };
  try {
    const r = await resolveProviderForUser(userId, 'generation');
    const ping = await r.provider.ping();
    gen = { providerId: r.providerId, model: r.model, ok: ping.ok, message: ping.message };
  } catch (err) {
    gen = {
      providerId: 'ollama',
      model: env.DEFAULT_GENERATION_MODEL,
      ok: false,
      message: (err as Error).message,
    };
  }

  let embed: { providerId: string; model: string; ok: boolean; message?: string };
  try {
    const r = await resolveProviderForUser(userId, 'embedding');
    const ping = await r.provider.ping();
    embed = { providerId: r.providerId, model: r.model, ok: ping.ok, message: ping.message };
  } catch (err) {
    embed = {
      providerId: 'ollama',
      model: env.DEFAULT_EMBEDDING_MODEL,
      ok: false,
      message: (err as Error).message,
    };
  }

  // Ollama-only: surface installed/missing models for the inbox banner.
  let ollamaInstalled: string[] = [];
  let ollamaMissing: string[] = [];
  if (gen.providerId === 'ollama' || embed.providerId === 'ollama') {
    try {
      const r = await resolveProviderForUser(userId, gen.providerId === 'ollama' ? 'generation' : 'embedding');
      if (r.provider instanceof OllamaProvider) {
        const list = await r.provider.listModels();
        ollamaInstalled = list.map((m) => m.name);
        const required = [
          ...(gen.providerId === 'ollama' ? [gen.model] : []),
          ...(embed.providerId === 'ollama' ? [embed.model] : []),
        ];
        ollamaMissing = required.filter(
          (m) =>
            !ollamaInstalled.some((installed) => installed === m || installed.startsWith(`${m}:`)),
        );
      }
    } catch {
      // ignored — gen.ok / embed.ok already flag the issue
    }
  }

  res.json({
    queues: { generate: genCounts, embed: embedCounts, imap: imapCounts },
    generation: gen,
    embedding: embed,
    ollama: { installedModels: ollamaInstalled, missingModels: ollamaMissing },
  });
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
