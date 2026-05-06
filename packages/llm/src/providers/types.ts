export type ProviderId = 'ollama' | 'anthropic' | 'openai';

export type GenerateOptions = {
  model: string;
  prompt: string;
  system?: string;
  /** Ollama-style 'json' format hint. Providers that don't support this
   *  fall back to instructing JSON-only via the system prompt. */
  format?: 'json';
  temperature?: number;
  /** Maps to Ollama `num_predict`, Anthropic `max_tokens`,
   *  OpenAI `max_tokens`. Null/undefined = provider default. */
  maxTokens?: number;
  /** Nucleus sampling. All three providers honour this. */
  topP?: number;
  /** Top-K sampling. Ollama-only — silently ignored elsewhere. */
  topK?: number;
  /** Penalty applied to tokens that have appeared recently.
   *  Ollama-only — silently ignored elsewhere. */
  repeatPenalty?: number;
  /** Context window size in tokens. Ollama-only — Anthropic/OpenAI
   *  derive this from the model. */
  numCtx?: number;
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
  /** Ollama emits `{"error": "..."}` ndjson lines mid-stream when
   *  a pull fails (model not found, HF 404, registry timeout).
   *  The proxy must surface this rather than treating it as a
   *  normal progress event. */
  error?: string;
};

export type PingResult = {
  ok: boolean;
  message?: string;
};

/** Image input for vision-capable models. Provide either a URL or
 *  base64-encoded bytes plus the MIME type. */
export type ImageInput =
  | { url: string }
  | { bytes: string; mimeType: string };

export type DescribeImageOptions = {
  /** Vision-capable model name. Falls back to the provider's default. */
  model?: string;
  /** Plain-language guidance, e.g. "Describe what this chart shows." */
  prompt?: string;
  signal?: AbortSignal;
};

/**
 * Common surface for any LLM backend. Capability flags are reported
 * separately so callers (e.g. the inline-image describer) can degrade
 * gracefully when the configured provider doesn't support vision.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  readonly supportsEmbeddings: boolean;
  /** True when the provider can describe an image. */
  readonly supportsVision: boolean;
  /** Streaming generation. Yields chunks as the model produces tokens. */
  generateStream(opts: GenerateOptions): AsyncGenerator<GenerateChunk>;
  /** Convenience: collect a full string. */
  generate(opts: GenerateOptions): Promise<string>;
  /** Throws if not supported. Always check `supportsEmbeddings` first. */
  embed(model: string, input: string, signal?: AbortSignal): Promise<number[]>;
  /** Returns a one-paragraph plain-language description. Throws when
   *  the provider doesn't support vision; check `supportsVision` first. */
  describeImage(image: ImageInput, opts?: DescribeImageOptions): Promise<string>;
  ping(signal?: AbortSignal): Promise<PingResult>;
  /** Optional: only Ollama implements model management today. */
  listModels?(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  pullModel?(model: string, signal?: AbortSignal): AsyncGenerator<PullEvent>;
  deleteModel?(model: string, signal?: AbortSignal): Promise<void>;
}
