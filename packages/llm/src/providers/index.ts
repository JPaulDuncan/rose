export * from './types.js';
export { OllamaProvider, type OllamaProviderConfig } from './ollama.js';
export { AnthropicProvider, type AnthropicProviderConfig } from './anthropic.js';
export { OpenAIProvider, type OpenAIProviderConfig } from './openai.js';

import type { LlmProvider, ProviderId } from './types.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export type ProviderConfig =
  | { id: 'ollama'; baseUrl: string }
  | { id: 'anthropic'; apiKey: string; baseUrl?: string }
  | { id: 'openai'; apiKey: string; baseUrl?: string };

/** Build a provider instance from a typed config. */
export function buildProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.id) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: cfg.baseUrl });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    case 'openai':
      return new OpenAIProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (local or self-hosted)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};
