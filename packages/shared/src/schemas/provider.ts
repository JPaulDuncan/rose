import { z } from 'zod';

export const ProviderId = z.enum(['ollama', 'anthropic', 'openai']);
export type ProviderId = z.infer<typeof ProviderId>;

/** Roles the user can independently configure. */
export const ProviderRole = z.enum(['generation', 'embedding']);
export type ProviderRole = z.infer<typeof ProviderRole>;

/** Optional sampling overrides for the generation provider. Null = use
 *  the worker's per-call default. topK/repeatPenalty/numCtx are
 *  Ollama-only; OpenAI/Anthropic ignore them. */
export const GenerationParams = z.object({
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxTokens: z.number().int().min(1).max(32768).nullable().default(null),
  topP: z.number().min(0).max(1).nullable().default(null),
  topK: z.number().int().min(1).max(200).nullable().default(null),
  repeatPenalty: z.number().min(0).max(4).nullable().default(null),
  numCtx: z.number().int().min(512).max(131072).nullable().default(null),
});
export type GenerationParams = z.infer<typeof GenerationParams>;

/** How a role should be served on Ollama. Maps to the `num_gpu`
 *  option on Ollama's /api/generate call:
 *    auto → no override, Ollama picks based on VRAM
 *    gpu  → num_gpu = 999 (every layer on GPU)
 *    cpu  → num_gpu = 0   (every layer on CPU)
 *  Anthropic / OpenAI ignore the field — they're not local. */
export const Device = z.enum(['auto', 'gpu', 'cpu']);
export type Device = z.infer<typeof Device>;

/** Public view of a user's provider settings. API keys are NEVER returned. */
export const ProviderSettings = z.object({
  generation: z.object({
    provider: ProviderId.default('ollama'),
    model: z.string().default('llama3.1:8b-instruct'),
    device: Device.default('auto'),
    params: GenerationParams.default({
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      repeatPenalty: null,
      numCtx: null,
    }),
  }),
  embedding: z.object({
    /** Anthropic excluded — no embeddings API. */
    provider: z.enum(['ollama', 'openai']).default('ollama'),
    model: z.string().default('nomic-embed-text'),
    device: Device.default('auto'),
  }),
  ollama: z.object({
    /** Empty/undefined = use the docker-compose default (`http://ollama:11434`). */
    baseUrl: z.string().url().or(z.literal('')).default(''),
    /** Per-role overrides; empty = fall back to baseUrl, then env. */
    generationBaseUrl: z.string().url().or(z.literal('')).default(''),
    embeddingBaseUrl: z.string().url().or(z.literal('')).default(''),
    visionBaseUrl: z.string().url().or(z.literal('')).default(''),
  }),
  anthropic: z.object({
    hasApiKey: z.boolean().default(false),
    baseUrl: z.string().url().or(z.literal('')).default(''),
  }),
  openai: z.object({
    hasApiKey: z.boolean().default(false),
    baseUrl: z.string().url().or(z.literal('')).default(''),
  }),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

/** Update payload — API keys are write-only and `null` means "clear". */
export const ProviderSettingsUpdate = z.object({
  generation: z
    .object({
      provider: ProviderId.optional(),
      model: z.string().min(1).optional(),
      device: Device.optional(),
      params: GenerationParams.partial().optional(),
    })
    .optional(),
  embedding: z
    .object({
      provider: z.enum(['ollama', 'openai']),
      model: z.string().min(1),
      device: Device.optional(),
    })
    .optional(),
  ollama: z
    .object({
      baseUrl: z.string().url().or(z.literal('')).optional(),
      generationBaseUrl: z.string().url().or(z.literal('')).optional(),
      embeddingBaseUrl: z.string().url().or(z.literal('')).optional(),
      visionBaseUrl: z.string().url().or(z.literal('')).optional(),
    })
    .optional(),
  anthropic: z
    .object({
      apiKey: z.string().min(1).nullable().optional(),
      baseUrl: z.string().url().or(z.literal('')).optional(),
    })
    .optional(),
  openai: z
    .object({
      apiKey: z.string().min(1).nullable().optional(),
      baseUrl: z.string().url().or(z.literal('')).optional(),
    })
    .optional(),
});
export type ProviderSettingsUpdate = z.infer<typeof ProviderSettingsUpdate>;

export const ProviderTestRequest = z.object({
  role: ProviderRole,
});
export type ProviderTestRequest = z.infer<typeof ProviderTestRequest>;

export const ProviderTestResponse = z.object({
  ok: z.boolean(),
  provider: ProviderId,
  model: z.string(),
  message: z.string().optional(),
});
export type ProviderTestResponse = z.infer<typeof ProviderTestResponse>;

/** Human-readable label for a provider. UI-facing only. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (local or self-hosted)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/** Catalog of suggested models per provider, surfaced in the UI dropdowns. */
export const SUGGESTED_MODELS: Record<
  ProviderId,
  { generation: string[]; embedding: string[]; vision: string[] }
> = {
  ollama: {
    generation: ['llama3.1:8b-instruct', 'llama3.1:70b-instruct', 'qwen2.5:7b', 'mistral:7b-instruct'],
    embedding: ['nomic-embed-text', 'mxbai-embed-large'],
    vision: ['llava', 'llava:13b', 'llama3.2-vision', 'bakllava'],
  },
  anthropic: {
    generation: [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ],
    embedding: [],
    vision: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  },
  openai: {
    generation: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    vision: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
};
