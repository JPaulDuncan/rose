import { Types } from 'mongoose';
import { User } from '@rose/db';
import {
  type LlmProvider,
  type ProviderId,
  buildProvider,
} from '@rose/llm';
import { decryptJson } from './crypto.js';
import { env } from './env.js';
import { adminUserId } from './adminUser.js';

export type GenerationParamOverrides = {
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  repeatPenalty?: number | null;
  numCtx?: number | null;
};

export type ResolvedProvider = {
  provider: LlmProvider;
  providerId: ProviderId;
  model: string;
  params: GenerationParamOverrides;
  /** Ollama-only layer-offload target, derived from
   *  `User.providers.<role>.device`. See applyParamOverrides for how
   *  callers thread this into provider.generate / .embed calls. */
  numGpu?: number;
};

type Role = 'generation' | 'embedding' | 'vision';

type DecryptedKey = { v: string };

/** auto → undefined, gpu → 999, cpu → 0. See API mirror for context. */
function deviceToNumGpu(device: 'auto' | 'gpu' | 'cpu' | undefined): number | undefined {
  if (device === 'gpu') return 999;
  if (device === 'cpu') return 0;
  return undefined;
}

/** Inject numGpu on every generate/embed call so call-sites don't
 *  have to thread the role's device choice manually. */
function withDevicePin(base: LlmProvider, numGpu: number | undefined): LlmProvider {
  if (numGpu == null) return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (prop === 'generate' || prop === 'generateStream') {
        return (opts: { numGpu?: number; [k: string]: unknown }) =>
          (orig as (o: unknown) => unknown).call(target, {
            ...opts,
            numGpu: opts.numGpu ?? numGpu,
          });
      }
      if (prop === 'embed') {
        return (
          model: string,
          input: string,
          signal?: AbortSignal,
          callerNumGpu?: number,
        ) =>
          (orig as LlmProvider['embed']).call(
            target,
            model,
            input,
            signal,
            callerNumGpu ?? numGpu,
          );
      }
      return typeof orig === 'function' ? orig.bind(target) : orig;
    },
  });
}

function ollamaUrlForRole(
  cfg: { baseUrl?: string; generationBaseUrl?: string; embeddingBaseUrl?: string; visionBaseUrl?: string } | undefined,
  role: Role,
): string {
  const roleSpecific =
    role === 'generation'
      ? cfg?.generationBaseUrl
      : role === 'embedding'
        ? cfg?.embeddingBaseUrl
        : cfg?.visionBaseUrl;
  return (roleSpecific?.trim() || cfg?.baseUrl?.trim() || env.OLLAMA_URL) as string;
}

/**
 * Mirror of the API's resolver. Provider config is deployment-wide —
 * every job, regardless of which user owns the data, runs through
 * the admin user's `User.providers`. Keeping the userId argument on
 * the signature avoids touching every call site.
 */
export async function resolveProviderForUser(
  _userId: Types.ObjectId | string,
  role: Role,
): Promise<ResolvedProvider> {
  const adminId = await adminUserId();
  if (!adminId) {
    throw new Error('ADMIN_EMAIL is not configured — provider settings are unavailable.');
  }
  const user = await User.findById(adminId)
    .select('+providers.anthropic.encryptedApiKey +providers.openai.encryptedApiKey');
  if (!user) {
    throw new Error('Admin user not found — provider settings are unavailable.');
  }

  const cfg = user.providers ?? {};
  const cfgRole: 'generation' | 'embedding' = role === 'vision' ? 'generation' : role;
  const roleCfg = cfg[cfgRole] ?? {
    provider: 'ollama' as ProviderId,
    model: cfgRole === 'generation' ? env.DEFAULT_GENERATION_MODEL : env.DEFAULT_EMBEDDING_MODEL,
  };
  const providerId = (roleCfg.provider as ProviderId) ?? 'ollama';
  const model =
    roleCfg.model ||
    (cfgRole === 'generation' ? env.DEFAULT_GENERATION_MODEL : env.DEFAULT_EMBEDDING_MODEL);
  const params: GenerationParamOverrides =
    cfgRole === 'generation'
      ? ((cfg.generation?.params as GenerationParamOverrides | undefined) ?? {})
      : {};
  const deviceCfg = cfg[cfgRole]?.device as 'auto' | 'gpu' | 'cpu' | undefined;
  const numGpu = deviceToNumGpu(deviceCfg);

  if (providerId === 'ollama') {
    const baseUrl = ollamaUrlForRole(cfg.ollama ?? undefined, role);
    const provider = withDevicePin(
      buildProvider({ id: 'ollama', baseUrl }),
      numGpu,
    );
    return { provider, providerId, model, params, numGpu };
  }

  if (providerId === 'anthropic') {
    if (cfgRole === 'embedding') {
      throw new Error('Anthropic does not support embeddings — choose Ollama or OpenAI.');
    }
    const enc = cfg.anthropic?.encryptedApiKey;
    if (!enc) throw new Error('Anthropic API key is not configured.');
    const apiKey = decryptJson<DecryptedKey>(enc).v;
    const baseUrl = cfg.anthropic?.baseUrl?.trim() || undefined;
    return {
      provider: buildProvider({ id: 'anthropic', apiKey, baseUrl }),
      providerId,
      model,
      params,
    };
  }

  if (providerId === 'openai') {
    const enc = cfg.openai?.encryptedApiKey;
    if (!enc) throw new Error('OpenAI API key is not configured.');
    const apiKey = decryptJson<DecryptedKey>(enc).v;
    const baseUrl = cfg.openai?.baseUrl?.trim() || undefined;
    return {
      provider: buildProvider({ id: 'openai', apiKey, baseUrl }),
      providerId,
      model,
      params,
    };
  }

  throw new Error(`Unknown provider: ${providerId as string}`);
}

/**
 * Merge a call-site default object (e.g. `{ temperature: 0.2 }`) with
 * the user's saved overrides — non-null user values win. Returns the
 * full merged set so call sites can spread every supported sampler
 * field into `provider.generate()` whether the user set it or not.
 *
 * If `resolved` is supplied, its `numGpu` (the device-pin layer
 * count derived from the user's Auto/GPU/CPU setting) is folded in
 * so the spread carries it automatically.
 */
export function applyParamOverrides(
  defaults: GenerationParamOverrides,
  overrides: GenerationParamOverrides,
  resolved?: { numGpu?: number },
): Required<{ [K in keyof GenerationParamOverrides]: number | null }> & {
  numGpu?: number;
} {
  const merged: Record<string, number | null | undefined> = {
    temperature: null,
    maxTokens: null,
    topP: null,
    topK: null,
    repeatPenalty: null,
    numCtx: null,
    ...defaults,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null) merged[k] = v;
  }
  if (resolved?.numGpu != null) merged.numGpu = resolved.numGpu;
  return merged as Required<{
    [K in keyof GenerationParamOverrides]: number | null;
  }> & { numGpu?: number };
}
