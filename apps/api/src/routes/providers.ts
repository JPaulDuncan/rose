import { Router } from 'express';
import {
  ProviderSettings,
  ProviderSettingsUpdate,
  ProviderTestRequest,
  type ProviderTestResponse,
} from '@rose/shared';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { encryptJson } from '../lib/crypto.js';
import { resolveProviderForUser } from '../lib/providers.js';

export const providersRouter: Router = Router();

/** Read current provider settings. API keys are NEVER returned — only `hasApiKey` flags. */
providersRouter.get('/', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId)
    .select('+providers.anthropic.encryptedApiKey +providers.openai.encryptedApiKey');
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'User not found' });
    return;
  }
  const cfg = user.providers ?? {};
  const safe = ProviderSettings.parse({
    generation: {
      provider: cfg.generation?.provider ?? 'ollama',
      model: cfg.generation?.model ?? 'llama3.1:8b-instruct',
      params: {
        temperature: cfg.generation?.params?.temperature ?? null,
        maxTokens: cfg.generation?.params?.maxTokens ?? null,
        topP: cfg.generation?.params?.topP ?? null,
        topK: cfg.generation?.params?.topK ?? null,
        repeatPenalty: cfg.generation?.params?.repeatPenalty ?? null,
        numCtx: cfg.generation?.params?.numCtx ?? null,
      },
    },
    embedding: {
      provider: cfg.embedding?.provider ?? 'ollama',
      model: cfg.embedding?.model ?? 'nomic-embed-text',
    },
    ollama: {
      baseUrl: cfg.ollama?.baseUrl ?? '',
      generationBaseUrl: cfg.ollama?.generationBaseUrl ?? '',
      embeddingBaseUrl: cfg.ollama?.embeddingBaseUrl ?? '',
      visionBaseUrl: cfg.ollama?.visionBaseUrl ?? '',
    },
    anthropic: {
      hasApiKey: !!cfg.anthropic?.encryptedApiKey,
      baseUrl: cfg.anthropic?.baseUrl ?? '',
    },
    openai: {
      hasApiKey: !!cfg.openai?.encryptedApiKey,
      baseUrl: cfg.openai?.baseUrl ?? '',
    },
  });
  res.json(safe);
});

providersRouter.patch('/', validateBody(ProviderSettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof ProviderSettingsUpdate._type;
  const user = await User.findById(userId);
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'User not found' });
    return;
  }
  // Mongoose's inferred shape for deeply-nested subdocs is strict; cast through
  // Record so partial in-place mutation typechecks. The runtime shape is fine.
  const p = (user.providers ??
    ({} as Record<string, unknown>)) as Record<string, Record<string, unknown>>;
  if (body.generation) {
    // Deep-merge params so a partial update (e.g. just temperature)
    // doesn't blow away the rest of the sampling knobs.
    const incoming = body.generation;
    const existing = (p.generation ?? {}) as Record<string, unknown>;
    p.generation = {
      ...existing,
      ...incoming,
      ...(incoming.params
        ? { params: { ...((existing.params as Record<string, unknown>) ?? {}), ...incoming.params } }
        : {}),
    };
  }
  if (body.embedding) p.embedding = { ...(p.embedding ?? {}), ...body.embedding };
  if (body.ollama) p.ollama = { ...(p.ollama ?? {}), ...body.ollama };
  if (body.anthropic) {
    p.anthropic = { ...(p.anthropic ?? {}) };
    if ('apiKey' in body.anthropic) {
      p.anthropic.encryptedApiKey =
        body.anthropic.apiKey === null ? null : encryptJson({ v: body.anthropic.apiKey });
    }
    if (typeof body.anthropic.baseUrl === 'string') p.anthropic.baseUrl = body.anthropic.baseUrl;
  }
  if (body.openai) {
    p.openai = { ...(p.openai ?? {}) };
    if ('apiKey' in body.openai) {
      p.openai.encryptedApiKey =
        body.openai.apiKey === null ? null : encryptJson({ v: body.openai.apiKey });
    }
    if (typeof body.openai.baseUrl === 'string') p.openai.baseUrl = body.openai.baseUrl;
  }
  user.set('providers', p);
  user.markModified('providers');
  await user.save();
  res.json({ ok: true });
});

/** Live-test the configured provider for a given role (generation or embedding). */
providersRouter.post('/test', validateBody(ProviderTestRequest), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof ProviderTestRequest._type;
  try {
    const { provider, providerId, model } = await resolveProviderForUser(userId, body.role);
    if (body.role === 'embedding') {
      if (!provider.supportsEmbeddings) {
        const r: ProviderTestResponse = {
          ok: false,
          provider: providerId,
          model,
          message: `${providerId} does not support embeddings.`,
        };
        res.status(400).json(r);
        return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        await provider.embed(model, 'rose health probe', ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
    } else {
      const ping = await provider.ping();
      if (!ping.ok) {
        const r: ProviderTestResponse = {
          ok: false,
          provider: providerId,
          model,
          message: ping.message ?? 'Ping failed',
        };
        res.status(400).json(r);
        return;
      }
    }
    const r: ProviderTestResponse = { ok: true, provider: providerId, model };
    res.json(r);
  } catch (err) {
    const r: ProviderTestResponse = {
      ok: false,
      provider: 'ollama',
      model: '',
      message: (err as Error).message,
    };
    res.status(400).json(r);
  }
});
