import type {
  DescribeImageOptions,
  GenerateChunk,
  GenerateOptions,
  ImageInput,
  LlmProvider,
  ModelDescriptor,
  PingResult,
  PullEvent,
} from './types.js';

export type OllamaProviderConfig = {
  baseUrl: string;
};

/** Yields newline-delimited JSON objects from a fetch response stream. */
async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // Ignore malformed lines (Ollama occasionally emits partial frames).
      }
    }
  }
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly supportsEmbeddings = true;
  /** Ollama supports vision via models like `llava`, `bakllava`,
   *  `llama3.2-vision`. Capability is per-model on Ollama, but the
   *  API accepts the `images` field on `/api/generate` regardless;
   *  the model errors out if it can't handle them. We report true
   *  here and let the caller pin a vision-capable model. */
  readonly supportsVision = true;

  constructor(private readonly cfg: OllamaProviderConfig) {}

  async *generateStream(opts: GenerateOptions): AsyncGenerator<GenerateChunk> {
    const res = await fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        system: opts.system,
        format: opts.format,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.2,
          num_ctx: 8192,
        },
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama generate failed (${res.status}): ${body.slice(0, 500)}`);
    }
    for await (const chunk of ndjson<{ response?: string; done?: boolean }>(res.body)) {
      yield { response: chunk.response ?? '', done: !!chunk.done };
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    let out = '';
    for await (const chunk of this.generateStream(opts)) out += chunk.response;
    return out;
  }

  async embed(model: string, input: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetch(`${this.cfg.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: input }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama embeddings failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding) throw new Error('Ollama embeddings missing `embedding` field');
    return json.embedding;
  }

  async describeImage(image: ImageInput, opts: DescribeImageOptions = {}): Promise<string> {
    // Ollama wants base64 (no data: prefix). When a URL was supplied,
    // the caller is responsible for fetching + base64-encoding.
    if ('url' in image) {
      throw new Error('Ollama vision requires base64 bytes, not a URL');
    }
    const model = opts.model ?? 'llava';
    const prompt = opts.prompt ?? 'Describe this image in one short paragraph.';
    const res = await fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [image.bytes],
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama vision failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { response?: string };
    return (json.response ?? '').trim();
  }

  async ping(signal?: AbortSignal): Promise<PingResult> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal });
      return { ok: res.ok, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama tags failed (${res.status})`);
    const json = (await res.json()) as {
      models?: { name: string; size?: number; modified_at?: string; digest?: string }[];
    };
    return (json.models ?? []).map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      digest: m.digest,
    }));
  }

  /**
   * `/api/ps` — currently-loaded models with their RAM/VRAM footprint and
   * processor placement. Surfaced in the Models settings tab so the user
   * can see what's pinned in memory at any moment.
   */
  async psModels(signal?: AbortSignal): Promise<
    {
      name: string;
      model?: string;
      size?: number;
      sizeVram?: number;
      digest?: string;
      expiresAt?: string;
    }[]
  > {
    const res = await fetch(`${this.cfg.baseUrl}/api/ps`, { signal });
    if (!res.ok) throw new Error(`Ollama ps failed (${res.status})`);
    const json = (await res.json()) as {
      models?: {
        name: string;
        model?: string;
        size?: number;
        size_vram?: number;
        digest?: string;
        expires_at?: string;
      }[];
    };
    return (json.models ?? []).map((m) => ({
      name: m.name,
      model: m.model,
      size: m.size,
      sizeVram: m.size_vram,
      digest: m.digest,
      expiresAt: m.expires_at,
    }));
  }

  async *pullModel(model: string, signal?: AbortSignal): AsyncGenerator<PullEvent> {
    const res = await fetch(`${this.cfg.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama pull failed (${res.status}): ${body.slice(0, 500)}`);
    }
    for await (const ev of ndjson<PullEvent>(res.body)) yield ev;
  }

  async deleteModel(model: string, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama delete failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }
}
