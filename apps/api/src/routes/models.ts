import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OllamaProvider } from '@rose/llm';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Resolve the user's Ollama base URL (their override or the env default).
 * All endpoints in this router are Ollama-only — cloud providers have no
 * pull/delete concept.
 */
async function ollamaForUser(userId: string): Promise<OllamaProvider> {
  const user = await User.findById(userId);
  const baseUrl = user?.providers?.ollama?.baseUrl?.trim() || env.OLLAMA_URL;
  return new OllamaProvider({ baseUrl });
}

export const modelsRouter: Router = Router();

modelsRouter.get('/', async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const ollama = await ollamaForUser(userId);
    const models = await ollama.listModels();
    res.json({ models });
  } catch (err) {
    next(err);
  }
});

const PullBody = z.object({ name: z.string().min(1).max(200) });

modelsRouter.post('/pull', validateBody(PullBody), async (req, res, next) => {
  // Non-streaming variant: enqueue the pull as fire-and-forget and return
  // immediately. Most callers should use the streaming endpoint below.
  try {
    const userId = userIdOf(req);
    const { name } = req.body as z.infer<typeof PullBody>;
    const ollama = await ollamaForUser(userId);
    void (async () => {
      try {
        for await (const _ of ollama.pullModel(name)) void _;
      } catch (err) {
        logger.warn({ err, name }, 'background ollama pull failed');
      }
    })();
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

modelsRouter.delete('/:name', async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const ollama = await ollamaForUser(userId);
    await ollama.deleteModel(req.params.name ?? '');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Streaming pull. Mounted on a separate router (no auth middleware) so that
 * EventSource clients can authenticate via `?access_token=` query param like
 * we do for the job stream.
 */
export const modelsStreamRouter: Router = Router();

modelsStreamRouter.get('/pull/stream', async (req: Request, res: Response) => {
  const header = req.headers.authorization ?? '';
  const token =
    (header.startsWith('Bearer ') ? header.slice(7) : null) ??
    ((req.query.access_token as string | undefined) ?? null);
  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing access token' });
    return;
  }
  let userId: string;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    userId = payload.sub;
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }
  const name = (req.query.name as string | undefined) ?? '';
  if (!name) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing model name' });
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
  send({ type: 'connected', name });

  const ollama = await ollamaForUser(userId);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  try {
    for await (const ev of ollama.pullModel(name, ctrl.signal)) send({ type: 'progress', ...ev });
    send({ type: 'completed', name });
  } catch (err) {
    send({ type: 'failed', name, message: (err as Error).message });
  } finally {
    res.end();
  }
});
