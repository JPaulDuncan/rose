export type ProviderId = 'ollama' | 'anthropic' | 'openai';

export type GenerateOptions = {
  model: string;
  prompt: string;
  system?: string;
  /** Ollama-style 'json' format hint. Providers that don't support this
   *  fall back to instructing JSON-only via the system prompt. */
  format?: 'json';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type GenerateChunk = {
  response: string;
  done: boolean;
};

export type ModelDescriptor = {
  name: string;
  /** Optional metadata. Ollama returns size/digest; cloud APIs may not. */
  size?: number;
  modifiedAt?: string;
  digest?: string;
};

export type PullEvent = {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
};

export type PingResult = {
  ok: boolean;
  message?: string;
};

/**
 * Common surface for any LLM backend. Embedding capability is reported
 * separately because Anthropic doesn't offer embeddings.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  readonly supportsEmbeddings: boolean;
  /** Streaming generation. Yields chunks as the model produces tokens. */
  generateStream(opts: GenerateOptions): AsyncGenerator<GenerateChunk>;
  /** Convenience: collect a full string. */
  generate(opts: GenerateOptions): Promise<string>;
  /** Throws if not supported. Always check `supportsEmbeddings` first. */
  embed(model: string, input: string, signal?: AbortSignal): Promise<number[]>;
  ping(signal?: AbortSignal): Promise<PingResult>;
  /** Optional: only Ollama implements model management today. */
  listModels?(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  pullModel?(model: string, signal?: AbortSignal): AsyncGenerator<PullEvent>;
  deleteModel?(model: string, signal?: AbortSignal): Promise<void>;
}
