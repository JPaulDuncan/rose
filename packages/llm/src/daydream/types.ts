/**
 * One snippet of context returned by an adapter for a query. Multiple
 * adapters can return snippets for the same query; the worker picks
 * the highest-confidence ones to feed into LLM synthesis.
 */
export type DaydreamSnippet = {
  title: string;
  url: string;
  /** Plain text. Adapters strip HTML/markup before returning. */
  content: string;
  /** 0–1 — adapter's own estimate of how on-topic the snippet is. */
  confidence: number;
  fetchedAt: Date;
};

export type AdapterContext = {
  /** Hard ceiling for one adapter call. */
  timeoutMs: number;
  /** ISO language tag for sources that support it ('en', 'es', …). */
  lang?: string;
  /** Stack Exchange site list, etc. — adapter-specific config. */
  options?: Record<string, unknown>;
  /** Optional fetch override so the worker can route through its
   *  cache. Adapters use this instead of bare `fetch` so the test
   *  harness + Redis cache can intercept transparently. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export interface DaydreamAdapter {
  readonly id: string;
  readonly label: string;
  readonly enabledByDefault: boolean;
  fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]>;
}
