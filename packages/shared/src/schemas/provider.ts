import { z } from 'zod';

export const ProviderId = z.enum(['ollama', 'anthropic', 'openai']);
export type ProviderId = z.infer<typeof ProviderId>;

/** Roles the user can independently configure. */
export const ProviderRole = z.enum(['generation', 'embedding']);
export type ProviderRole = z.infer<typeof ProviderRole>;

/** Public view of a user's provider settings. API keys are NEVER returned. */
export const ProviderSettings = z.object({
  generation: z.object({
    provider: ProviderId.default('ollama'),
    model: z.string().default('llama3.1:8b-instruct'),
  }),
  embedding: z.object({
    /** Anthropic excluded — no embeddings API. */
    provider: z.enum(['ollama', 'openai']).default('ollama'),
    model: z.string().default('nomic-embed-text'),
  }),
  ollama: z.object({
    /** Empty/undefined = use the docker-compose default (`http://ollama:11434`). */
    baseUrl: z.string().url().or(z.literal('')).default(''),
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
      provider: ProviderId,
      model: z.string().min(1),
    })
    .optional(),
  embedding: z
    .object({
      provider: z.enum(['ollama', 'openai']),
      model: z.string().min(1),
    })
    .optional(),
  ollama: z
    .object({
      baseUrl: z.string().url().or(z.literal('')).optional(),
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
  { generation: string[]; embedding: string[] }
> = {
  ollama: {
    generation: ['llama3.1:8b-instruct', 'llama3.1:70b-instruct', 'qwen2.5:7b', 'mistral:7b-instruct'],
    embedding: ['nomic-embed-text', 'mxbai-embed-large'],
  },
  anthropic: {
    generation: [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ],
    embedding: [],
  },
  openai: {
    generation: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
  },
};
