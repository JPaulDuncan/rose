import type {
  DescribeImageOptions,
  GenerateChunk,
  GenerateOptions,
  ImageInput,
  LlmProvider,
  PingResult,
} from './types.js';

export type OpenAIProviderConfig = {
  apiKey: string;
  /** Optional override for OpenAI-compatible APIs (e.g. Azure, Together, etc.). */
  baseUrl?: string;
};

const DEFAULT_BASE = 'https://api.openai.com';

type ChatChunk = {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
};

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly supportsEmbeddings = true;
  readonly supportsVision = true;

  constructor(private readonly cfg: OpenAIProviderConfig) {}

  async *generateStream(opts: GenerateOptions): AsyncGenerator<GenerateChunk> {
    const baseUrl = this.cfg.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
        // top_p passed through when set; OpenAI doesn't expose top_k or
        // a vendor-style repeat_penalty on the public API.
        ...(opts.topP != null ? { top_p: opts.topP } : {}),
        ...(opts.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.prompt },
        ],
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI generate failed (${res.status}): ${body.slice(0, 500)}`);
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
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const chunk = JSON.parse(payload) as ChatChunk;
          const text = chunk.choices?.[0]?.delta?.content ?? '';
          const finished = !!chunk.choices?.[0]?.finish_reason;
          if (text) yield { response: text, done: false };
          if (finished) {
            yield { response: '', done: true };
            return;
          }
        } catch {
          // ignore malformed
        }
      }
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    let out = '';
    for await (const chunk of this.generateStream(opts)) out += chunk.response;
    return out;
  }

  async embed(
    model: string,
    input: string,
    signal?: AbortSignal,
    _numGpu?: number,
  ): Promise<number[]> {
    const baseUrl = this.cfg.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({ model, input }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const vec = json.data?.[0]?.embedding;
    if (!vec) throw new Error('OpenAI embeddings response missing data[0].embedding');
    return vec;
  }

  async describeImage(image: ImageInput, opts: DescribeImageOptions = {}): Promise<string> {
    const baseUrl = this.cfg.baseUrl ?? DEFAULT_BASE;
    const model = opts.model ?? 'gpt-4o-mini';
    const promptText =
      opts.prompt ?? 'Describe this image in one short paragraph.';
    const imageUrl =
      'url' in image
        ? image.url
        : `data:${image.mimeType};base64,${image.bytes}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI vision failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return (json.choices?.[0]?.message?.content ?? '').trim();
  }

  async ping(signal?: AbortSignal): Promise<PingResult> {
    if (!this.cfg.apiKey) return { ok: false, message: 'No API key configured' };
    try {
      const res = await fetch(`${this.cfg.baseUrl ?? DEFAULT_BASE}/v1/models`, {
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        signal,
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => '');
      return { ok: false, message: `${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
