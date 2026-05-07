import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OllamaProvider } from '@rose/llm';
import { Types } from 'mongoose';
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

/** Same resolution as ollamaForUser but returns the raw URL for
 *  endpoints that talk to Ollama directly (blob upload, model create). */
async function ollamaBaseUrlForUser(userId: string): Promise<string> {
  const user = await User.findById(userId);
  return user?.providers?.ollama?.baseUrl?.trim() || env.OLLAMA_URL;
}

/**
 * Normalise a user-supplied Ollama model reference. Ollama's
 * registry convention is roughly:
 *
 *   • `llama3.1:8b-instruct`            — registry default
 *   • `library/llama3.1:8b-instruct`    — explicit registry namespace
 *   • `hf.co/<user>/<repo>[:tag]`        — Hugging Face GGUF
 *   • `huggingface.co/<user>/<repo>`     — same, longer form
 *   • `example.com/foo`                  — custom registry
 *
 * Users who paste an HF reference like `unsloth/Qwen3.5-9B-GGUF`
 * (without the `hf.co/` prefix) hit a registry 404 because Ollama
 * tries `registry.ollama.ai/unsloth/Qwen3.5-9B-GGUF`. We auto-
 * prefix `hf.co/` when the input has a slash AND doesn't begin
 * with a known host, the `library/` namespace, or anything that
 * already looks like a fully-qualified registry path.
 */
/**
 * Re-case a single hyphen-delimited tag segment so it matches the
 * official Ollama naming convention. Library tags are case-sensitive
 * — `Q4_K_M` won't pull but `q4_K_M` will. Ollama's HuggingFace
 * integration is more forgiving but normalizing keeps the UI's
 * "currently installed" name stable.
 *
 * Conventions:
 *   q\d+_K_[SML]   → lowercase q + digit, uppercase K and trailing letter
 *   q\d+_K         → lowercase q + digit, uppercase K
 *   q\d+_\d+       → lowercase q (q4_0, q5_1, q8_0)
 *   iq\d+_…        → all lowercase (iq3_xxs, iq4_xs)
 *   fp16/fp32/bf16 → lowercase
 *
 * Anything else (ordinary words like "instruct", "14b") is left as
 * the user typed it, since base-tag casing IS preserved by Ollama.
 */
function normalizeQuantSegment(seg: string): string {
  if (!seg) return seg;
  // Q-K quants: q3_K_M, Q4_K_S, q5_K, q6_K, etc.
  const qkMatch = seg.match(/^[Qq](\d+)_[Kk](?:_([SsMmLl]))?$/);
  if (qkMatch) {
    const [, digits, suffixLetter] = qkMatch;
    return suffixLetter ? `q${digits}_K_${suffixLetter.toUpperCase()}` : `q${digits}_K`;
  }
  // Round-number quants: q4_0, q4_1, q5_0, q5_1, q8_0
  const qnMatch = seg.match(/^[Qq](\d+)_(\d+)$/);
  if (qnMatch) return `q${qnMatch[1]}_${qnMatch[2]}`;
  // IQ quants: iq3_xxs, iq4_xs, iq2_m, etc. — convention is all lowercase.
  if (/^iq\d+(?:_[a-z0-9]+)+$/i.test(seg)) return seg.toLowerCase();
  // Float precisions.
  if (/^(?:fp|f|bf)(?:16|32)$/i.test(seg)) return seg.toLowerCase();
  return seg;
}

/** Apply quant normalization to every hyphen-delimited segment in a tag. */
function normalizeTag(tag: string): string {
  return tag.split('-').map(normalizeQuantSegment).join('-');
}

/**
 * Pull a quant-style suffix out of a GGUF filename like
 * `Qwen2.5-14B-Instruct-Q4_K_M.gguf`. The HF tag selector matches on
 * a substring of the file basename; we only need the canonical form
 * of the most distinctive piece (the quant) to pin one specific
 * file. Returns null when no quant is found.
 */
function quantFromFilename(filename: string): string | null {
  const base = filename.replace(/\.gguf$/i, '');
  // Prefer the rightmost quant-looking segment (typical filename
  // pattern is "<base>-...-Q4_K_M.gguf").
  const segments = base.split(/[-_.]+/);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const norm = normalizeQuantSegment(segments[i]!);
    if (norm !== segments[i]) return norm;
    if (/^[Qq]\d+_[Kk]/.test(segments[i]!) || /^[Qq]\d+_\d+$/.test(segments[i]!)) {
      return normalizeQuantSegment(segments[i]!);
    }
  }
  return null;
}

/**
 * Normalize whatever the user typed into a canonical Ollama pull ref.
 * Accepts:
 *   • Library tags:   "qwen2.5:14b-instruct-q4_K_M" (case-fixed: Q4_K_M ↔ q4_K_M)
 *   • HF shorthand:   "Qwen/Qwen2.5-14B-Instruct-GGUF:Q4_K_M"
 *                     (auto-prefixes "hf.co/")
 *   • HF URLs:        "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF"
 *                     "https://huggingface.co/.../blob/main/qwen2.5-14b-instruct-q4_k_m.gguf"
 *                     "https://huggingface.co/.../resolve/main/<file>.gguf"
 *                     "https://hf.co/<owner>/<repo>/tree/main"
 *   • Already-canonical hf.co/<owner>/<repo>[:tag]
 *   • Custom registries (anything with a host in the first segment)
 *
 * In every case the quant suffix is re-cased to the Ollama
 * convention so the user doesn't have to remember q4_K_M vs Q4_K_M.
 */
export function normalizeOllamaRef(name: string): string {
  let trimmed = name.trim();
  if (!trimmed) return trimmed;

  // 1. Strip Hugging Face URL prefixes and rewrite path-style refs
  //    ("/blob/main/<file>", "/resolve/<rev>/<file>", "/tree/main")
  //    into the "<owner>/<repo>[:<tag>]" shape Ollama expects.
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/(.+?)\/?$/i,
  );
  if (urlMatch) {
    const path = urlMatch[1]!;
    const parts = path.split('/');
    const owner = parts[0]!;
    const repo = parts[1] ?? '';
    if (!owner || !repo) return trimmed; // malformed; let it fail loudly
    let tag: string | null = null;
    // /blob/<rev>/<...file> or /resolve/<rev>/<...file>
    if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'resolve')) {
      const filename = parts[parts.length - 1]!;
      tag = quantFromFilename(filename);
    }
    // /tree/<rev> — strip; default file selection
    trimmed = `hf.co/${owner}/${repo}${tag ? `:${tag}` : ''}`;
  }

  // 2. Already-canonical hf.co/ or huggingface.co/ paths: pass through
  //    after running the normalizer over the tag portion.
  if (/^(hf\.co|huggingface\.co)\//i.test(trimmed)) {
    const [base, ...tagParts] = trimmed.split(':');
    if (tagParts.length === 0) return base!;
    return `${base}:${normalizeTag(tagParts.join(':'))}`;
  }

  // 3. library/ namespace shorthand.
  if (/^library\//i.test(trimmed)) {
    const [base, ...tagParts] = trimmed.split(':');
    if (tagParts.length === 0) return base!;
    return `${base}:${normalizeTag(tagParts.join(':'))}`;
  }

  // 4. Custom registry (first segment looks like a host with a dot).
  if (trimmed.includes('/')) {
    const firstSegment = trimmed.split('/')[0]!;
    if (firstSegment.includes('.')) return trimmed;
    // 5. Bare <owner>/<repo>[:tag] → Hugging Face shorthand.
    const [base, ...tagParts] = trimmed.split(':');
    return `hf.co/${base}${tagParts.length > 0 ? `:${normalizeTag(tagParts.join(':'))}` : ''}`;
  }

  // 6. Plain library ref ("qwen2.5:14b-instruct-q4_K_M" or "qwen2.5").
  const [base, ...tagParts] = trimmed.split(':');
  if (tagParts.length === 0) return base!;
  return `${base}:${normalizeTag(tagParts.join(':'))}`;
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
    const resolved = normalizeOllamaRef(name);
    const ollama = await ollamaForUser(userId);
    void (async () => {
      try {
        for await (const ev of ollama.pullModel(resolved)) {
          if (ev.error) {
            logger.warn(
              { name, resolved, error: ev.error },
              'background ollama pull reported error',
            );
            return;
          }
        }
      } catch (err) {
        logger.warn({ err, name, resolved }, 'background ollama pull failed');
      }
    })();
    res.status(202).json({ ok: true, resolved });
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
 * Manual GGUF import: spool the multipart upload to a temp file,
 * compute its SHA-256, push it to Ollama as a blob, then call
 * Ollama's `/api/create` to register the model under whatever name
 * the user picked. The whole thing is one (long) HTTP request.
 *
 * For 14B-class models GGUFs land at 8–10 GB so the cap is set high
 * (50 GB) but the OS temp dir needs the same headroom.
 *
 * Body shape: multipart with two fields — `name` (the model name to
 * register, e.g. "qwen-14b-mine") and `file` (the `.gguf`).
 */
const ggufUpload = multer({
  storage: multer.diskStorage({
    destination: env.GGUF_UPLOAD_DIR || os.tmpdir(),
    filename: (_req, file, cb) =>
      cb(null, `rose-gguf-${Date.now()}-${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 * 1024 },
});

modelsRouter.post(
  '/upload',
  ggufUpload.single('file'),
  async (req, res, next) => {
    let tempPath: string | null = null;
    try {
      const userId = userIdOf(req);
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'invalid_request', message: 'No file uploaded' });
        return;
      }
      tempPath = file.path;
      if (!/\.gguf$/i.test(file.originalname)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'File must be a .gguf — that\'s the format Ollama imports.',
        });
        return;
      }
      const rawName = ((req.body as { name?: string })?.name ?? '').trim();
      if (!rawName) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'Missing model name (e.g. "qwen-14b-mine").',
        });
        return;
      }
      // Tag through the same normalizer for consistency, even though
      // upload names are usually plain "name:tag" without quant
      // suffixes. Strips trailing slashes / fixes casing if present.
      const modelName = normalizeOllamaRef(rawName);

      // Compute SHA-256 by streaming the file (Ollama validates the
      // hash in the URL against the body it receives).
      const hash = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const r = fs.createReadStream(tempPath!);
        r.on('data', (c) => hash.update(c as Buffer));
        r.on('end', () => resolve());
        r.on('error', reject);
      });
      const digest = hash.digest('hex');

      // Push the blob to Ollama. The `duplex: 'half'` option is
      // required by undici for streaming bodies; the cast keeps
      // typecheck happy across Node versions.
      const baseUrl = await ollamaBaseUrlForUser(userId);
      const stat = await fs.promises.stat(tempPath);
      const blobRes = await fetch(`${baseUrl}/api/blobs/sha256:${digest}`, {
        method: 'POST',
        headers: { 'Content-Length': String(stat.size) },
        body: fs.createReadStream(tempPath) as unknown as ReadableStream,
        // `duplex: 'half'` is required by undici when streaming a body
        // but isn't in lib.dom.d.ts. Cast through `unknown` so the
        // option lands at runtime without polluting the call site
        // with a global ts-expect-error.
        ...({ duplex: 'half' } as Record<string, unknown>),
      });
      if (!blobRes.ok) {
        const text = await blobRes.text().catch(() => '');
        logger.warn(
          { status: blobRes.status, body: text.slice(0, 500) },
          'ollama blob upload failed',
        );
        res.status(502).json({
          error: 'ollama_blob_failed',
          message: `Ollama blob upload failed (${blobRes.status}): ${text.slice(0, 200)}`,
        });
        return;
      }

      // Register the model. Ollama 0.5+ supports the "files" form of
      // /api/create which is exactly what we want — point at the
      // blob we just uploaded, no Modelfile string needed.
      const createRes = await fetch(`${baseUrl}/api/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          files: { [file.originalname]: `sha256:${digest}` },
        }),
      });
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => '');
        logger.warn(
          { status: createRes.status, body: text.slice(0, 500) },
          'ollama create failed',
        );
        res.status(502).json({
          error: 'ollama_create_failed',
          message: `Ollama create failed (${createRes.status}): ${text.slice(0, 200)}`,
        });
        return;
      }
      // Drain the create endpoint's progress stream — we wait for it
      // to finish before returning so the model is fully usable when
      // the response lands.
      if (createRes.body) {
        const reader = createRes.body.getReader();
        const decoder = new TextDecoder();
        let leftover = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            leftover += decoder.decode(value, { stream: true });
            const lines = leftover.split('\n');
            leftover = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const ev = JSON.parse(line) as { error?: string; status?: string };
                if (ev.error) {
                  res.status(502).json({
                    error: 'ollama_create_failed',
                    message: ev.error,
                  });
                  return;
                }
              } catch {
                // ignore non-JSON heartbeats
              }
            }
          }
        }
      }
      res.json({ ok: true, model: modelName, sizeBytes: stat.size });
    } catch (err) {
      next(err);
    } finally {
      if (tempPath) {
        await fs.promises.unlink(tempPath).catch(() => null);
      }
    }
  },
);

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
  // Admin gate: model pulls download multi-GB files into a shared
  // Ollama and need to be locked down to the deployment admin.
  // The router-level `requireAdmin` doesn't apply here because we
  // bypass `requireAuth` to take the access token from the query.
  if (!env.ADMIN_EMAIL) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const callerEmail = (
    await User.findById(new Types.ObjectId(userId)).select('email').lean()
  )?.email?.toLowerCase();
  if (callerEmail !== env.ADMIN_EMAIL) {
    res.status(403).json({ error: 'forbidden', message: 'Admin only' });
    return;
  }
  const rawName = (req.query.name as string | undefined) ?? '';
  if (!rawName) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing model name' });
    return;
  }
  const name = normalizeOllamaRef(rawName);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'connected', name, requested: rawName, resolved: name });

  const ollama = await ollamaForUser(userId);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  try {
    let failed = false;
    for await (const ev of ollama.pullModel(name, ctrl.signal)) {
      if (ev.error) {
        failed = true;
        logger.warn({ rawName, name, error: ev.error }, 'ollama pull stream reported error');
        send({ type: 'failed', name, message: ev.error });
        break;
      }
      send({ type: 'progress', ...ev });
    }
    if (!failed) send({ type: 'completed', name });
  } catch (err) {
    send({ type: 'failed', name, message: (err as Error).message });
  } finally {
    res.end();
  }
});
