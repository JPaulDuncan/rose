import type {
  DescribeImageOptions,
  GenerateChunk,
  GenerateOptions,
  ImageInput,
  LlmProvider,
  PingResult,
} from './types.js';

export type AnthropicProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  /** anthropic-version header. Pinned to a known-stable date. */
  apiVersion?: string;
};

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';

type StreamLine =
  | { type: 'message_start'; message: { id: string } }
  | { type: 'content_block_delta'; delta: { type: string; text?: string } }
  | { type: 'message_delta'; delta: { stop_reason?: string } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly supportsEmbeddings = false;
  readonly supportsVision = true;

  constructor(private readonly cfg: AnthropicProviderConfig) {}

  async *generateStream(opts: GenerateOptions): AsyncGenerator<GenerateChunk> {
    const baseUrl = this.cfg.baseUrl ?? DEFAULT_BASE;
    const system = [
      opts.system ?? '',
      // Anthropic has no `format: 'json'` option — instruct via system prompt.
      opts.format === 'json'
        ? '\nRespond with raw JSON only — no prose, no markdown fences.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': this.cfg.apiVersion ?? DEFAULT_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        system,
        messages: [{ role: 'user', content: opts.prompt }],
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.2,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic generate failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE: each event is a `data: ...` line, separated by blank lines.
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const ev = JSON.parse(payload) as StreamLine;
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            yield { response: ev.delta.text ?? '', done: false };
          } else if (ev.type === 'message_stop') {
            yield { response: '', done: true };
            return;
          } else if (ev.type === 'error') {
            throw new Error(`Anthropic stream error: ${ev.error.message}`);
          }
        } catch (err) {
          if ((err as Error).message?.startsWith('Anthropic stream error')) throw err;
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

  async embed(): Promise<number[]> {
    throw new Error(
      'Anthropic does not provide embeddings. Configure a separate embedding provider (Ollama or OpenAI).',
    );
  }

  async describeImage(image: ImageInput, opts: DescribeImageOptions = {}): Promise<string> {
    const baseUrl = this.cfg.baseUrl ?? DEFAULT_BASE;
    const model = opts.model ?? 'claude-haiku-4-5-20251001';
    const promptText =
      opts.prompt ?? 'Describe this image in one short paragraph.';
    const imageBlock =
      'url' in image
        ? { type: 'image', source: { type: 'url', url: image.url } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.bytes },
          };
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': this.cfg.apiVersion ?? DEFAULT_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [imageBlock, { type: 'text', text: promptText }],
          },
        ],
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic vision failed (${res.status}): ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    return (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim();
  }

  async ping(signal?: AbortSignal): Promise<PingResult> {
    if (!this.cfg.apiKey) return { ok: false, message: 'No API key configured' };
    // Anthropic has no cheap /health endpoint. Issue a 1-token messages call.
    try {
      const res = await fetch(`${this.cfg.baseUrl ?? DEFAULT_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.cfg.apiKey,
          'anthropic-version': this.cfg.apiVersion ?? DEFAULT_VERSION,
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
        }),
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
