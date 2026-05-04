import { Types } from 'mongoose';
import { User } from '@rose/db';
import {
  type LlmProvider,
  type ProviderId,
  buildProvider,
} from '@rose/llm';
import { decryptJson } from './crypto.js';
import { env } from './env.js';

/** Optional sampler overrides plumbed in from the user's settings.
 *  Each field is null/undefined when the user hasn't customised it,
 *  in which case the call site should fall back to its baked-in
 *  per-task default (e.g. 0.2 for JSON-mode wiki generation). */
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
};

type Role = 'generation' | 'embedding' | 'vision';

type DecryptedKey = { v: string };

/** Pick the per-role Ollama base URL with fallback to the global override
 *  and finally the env default. Lets users dedicate one Ollama instance to
 *  embeddings (fast, lightweight model) and another to generation (slow,
 *  bigger model) so the two don't head-of-line block each other. */
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
 * Look up a user's configured provider for the given role and instantiate it
 * with the right credentials. Falls back to the env-default Ollama when the
 * user has not configured anything yet. The 'vision' role piggybacks on the
 * generation provider but uses the vision-specific Ollama URL.
 */
export async function resolveProviderForUser(
  userId: Types.ObjectId | string,
  role: Role,
): Promise<ResolvedProvider> {
  const user = await User.findById(userId)
    .select('+providers.anthropic.encryptedApiKey +providers.openai.encryptedApiKey');
  if (!user) throw new Error('User not found');

  const cfg = user.providers ?? {};
  // Vision is not its own provider config — it follows generation, but we
  // route through the vision-specific URL when the user has set one.
  const cfgRole: 'generation' | 'embedding' = role === 'vision' ? 'generation' : role;
  const roleCfg = cfg[cfgRole] ?? {
    provider: 'ollama' as ProviderId,
    model: cfgRole === 'generation' ? env.DEFAULT_GENERATION_MODEL : env.DEFAULT_EMBEDDING_MODEL,
  };
  const providerId = (roleCfg.provider as ProviderId) ?? 'ollama';
  const model =
    roleCfg.model ||
    (cfgRole === 'generation' ? env.DEFAULT_GENERATION_MODEL : env.DEFAULT_EMBEDDING_MODEL);
  // Sampler overrides live on the generation role; embedding has none.
  // Vision inherits the generation role's params (it uses the same
  // model family for describe-image calls).
  const params: GenerationParamOverrides =
    cfgRole === 'generation'
      ? ((cfg.generation?.params as GenerationParamOverrides | undefined) ?? {})
      : {};

  if (providerId === 'ollama') {
    const baseUrl = ollamaUrlForRole(cfg.ollama ?? undefined, role);
    return { provider: buildProvider({ id: 'ollama', baseUrl }), providerId, model, params };
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
