export type OllamaConfig = {
  baseUrl: string;
  signal?: AbortSignal;
};

export type GenerateOptions = {
  model: string;
  prompt: string;
  system?: string;
  format?: 'json';
  temperature?: number;
  numCtx?: number;
};

export type GenerateChunk = {
  response: string;
  done: boolean;
};

export class OllamaClient {
  constructor(private readonly cfg: OllamaConfig) {}

  /** Streaming generation. Yields decoded chunks as Ollama emits them. */
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
          num_ctx: opts.numCtx ?? 8192,
        },
      }),
      signal: this.cfg.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama generate failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
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
          const chunk = JSON.parse(line) as { response?: string; done?: boolean };
          yield { response: chunk.response ?? '', done: !!chunk.done };
        } catch {
          // Ignore malformed line, Ollama occasionally emits partial frames during shutdown.
        }
      }
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    let out = '';
    for await (const chunk of this.generateStream(opts)) out += chunk.response;
    return out;
  }

  async embed(model: string, input: string): Promise<number[]> {
    const res = await fetch(`${this.cfg.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: input }),
      signal: this.cfg.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama embeddings failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding) throw new Error('Ollama embeddings missing `embedding` field');
    return json.embedding;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal: this.cfg.signal });
    if (!res.ok) throw new Error(`Ollama tags failed (${res.status})`);
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal: this.cfg.signal });
      return res.ok;
    } catch {
      return false;
    }
  }
}
