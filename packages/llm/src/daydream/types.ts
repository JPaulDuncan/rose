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

/**
 * Disambiguating context attached to a daydream subject. The same
 * surface form ("The Drama") can mean a film when it surfaces from
 * an email signed by A24 and the generic English noun when it
 * surfaces from a paragraph of prose. Without this, the synthesis
 * prompt has no way to pick the right interpretation; with it, both
 * the adapters' query-side ranking and the LLM's source selection
 * become disambiguation-aware.
 *
 * Every field is optional — callers fill in whatever they happen to
 * know. A near-empty context is fine; it just means we fall back to
 * the bare display-name lookup that v1 of daydream always did.
 */
export type DaydreamContext = {
  /** Title of the page that surfaced the subject, if any. */
  pageTitle?: string | null;
  /** Page tags — feeds the adapter's domain-affinity heuristics. */
  pageTags?: string[];
  /** Display name of the email sender (brand label, not address). */
  senderName?: string | null;
  /** Sender hostname — `a24films.com` for an email from `hello@a24films.com`. */
  senderDomain?: string | null;
  /** ~150 chars around the entity mention in the page body. Lets
   *  the LLM see the exact prose context. */
  excerpt?: string | null;
  /** Entity registry type, when the subject is a resolved Entity. */
  entityType?: 'person' | 'organization' | 'place' | 'work' | null;
};

export type AdapterContext = {
  /** Hard ceiling for one adapter call. */
  timeoutMs: number;
  /** ISO language tag for sources that support it ('en', 'es', …). */
  lang?: string;
  /** Adapter-specific knobs. The webFetch cache is passed here under
   *  the well-known key `cache` so adapters route through the
   *  shared Redis-backed memoiser. */
  options?: Record<string, unknown>;
  /** Disambiguating signals about the subject. Adapters that support
   *  it use these to rank candidates (e.g., Wikidata can boost
   *  results whose description matches the entity type). Adapters
   *  that don't care can safely ignore the field. */
  subjectContext?: DaydreamContext;
};

export interface DaydreamAdapter {
  readonly id: string;
  readonly label: string;
  readonly enabledByDefault: boolean;
  fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]>;
}
