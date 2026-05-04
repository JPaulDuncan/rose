import { Types } from 'mongoose';
import { User } from '@rose/db';
import {
  type LlmProvider,
  type ProviderId,
  buildProvider,
} from '@rose/llm';
import { decryptJson } from './crypto.js';
import { env } from './env.js';

export type ResolvedProvider = {
  provider: LlmProvider;
  providerId: ProviderId;
  model: string;
};

type Role = 'generation' | 'embedding' | 'vision';

type DecryptedKey = { v: string };

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

/** Mirror of the API's resolver. The worker also needs per-user provider routing. */
export async function resolveProviderForUser(
  userId: Types.ObjectId | string,
  role: Role,
): Promise<ResolvedProvider> {
  const user = await User.findById(userId)
    .select('+providers.anthropic.encryptedApiKey +providers.openai.encryptedApiKey');
  if (!user) throw new Error('User not found');

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

  if (providerId === 'ollama') {
    const baseUrl = ollamaUrlForRole(cfg.ollama ?? undefined, role);
    return { provider: buildProvider({ id: 'ollama', baseUrl }), providerId, model };
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
    };
  }

  throw new Error(`Unknown provider: ${providerId as string}`);
}
