/**
 * Backwards-compatible thin wrapper around OllamaProvider. The provider
 * interface is the canonical API; this just preserves the older two-method
 * shape (`ping(): boolean`, `listModels(): string[]`) that earlier callers
 * relied on. New code should use `OllamaProvider` from `@rose/llm` directly.
 */
import { OllamaProvider, type OllamaProviderConfig } from './providers/ollama.js';

export type OllamaConfig = OllamaProviderConfig & { signal?: AbortSignal };

export class OllamaClient {
  private readonly provider: OllamaProvider;
  constructor(private readonly cfg: OllamaConfig) {
    this.provider = new OllamaProvider({ baseUrl: cfg.baseUrl });
  }

  generateStream = (opts: Parameters<OllamaProvider['generateStream']>[0]) =>
    this.provider.generateStream({ signal: this.cfg.signal, ...opts });

  generate = (opts: Parameters<OllamaProvider['generate']>[0]) =>
    this.provider.generate({ signal: this.cfg.signal, ...opts });

  embed = (model: string, input: string) =>
    this.provider.embed(model, input, this.cfg.signal);

  /** Returns just the model names — the provider's listModels returns descriptors. */
  async listModels(): Promise<string[]> {
    const list = await this.provider.listModels(this.cfg.signal);
    return list.map((m) => m.name);
  }

  /** Backwards-compatible boolean ping. */
  async ping(): Promise<boolean> {
    return (await this.provider.ping(this.cfg.signal)).ok;
  }
}
