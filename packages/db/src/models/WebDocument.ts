import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Per-user cache of fetched web pages (web-integration Phase 1).
 *
 * The topic-research orchestrator persists every fetched URL it
 * could extract content from here, keyed by `(userId, urlHash)`.
 * The TTL index on `expiresAt` lets MongoDB evict stale entries
 * without bookkeeping; default retention is 14 days, which is the
 * sweet spot between "we already have this, skip the fetch" and
 * "the world has moved on, refresh."
 *
 * We deliberately do NOT reuse `LibraryDocument`. LibraryDocument
 * represents user-curated sources (a library the user opted into);
 * WebDocument represents Rose's auto-fetched research artefacts.
 * Mixing the two would tangle retention semantics — the user's
 * library shouldn't get TTL-evicted while research caches can.
 *
 * Indexed for the three hot lookups:
 *   • `(userId, urlHash)` unique — dedup on fetch.
 *   • `(userId, hostKey)` — debug "show me everything I've pulled
 *     from apnews.com" view in the future Codex tab.
 *   • TTL on `expiresAt` — automatic eviction.
 *   • `(userId, triggeringPageId)` — cleanup when a page is
 *     deleted, plus rendering its Sources Cited list.
 */
const webDocumentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Final URL after redirects. Stored verbatim. */
    url: { type: String, required: true },
    /**
     * SHA-256(finalUrl) so the unique index on `(userId, urlHash)`
     * can be small + fast — Mongo's index entries cap around 1KB
     * per key, and unbounded URLs risked overflow.
     */
    urlHash: { type: String, required: true },
    /** eTLD+1 from `tldts.parse(url).domain` — used for the per-host
     *  rate limiter and the (future) Codex hostname-grouped view. */
    hostKey: { type: String, required: true, index: true },
    title: { type: String, default: '' },
    /** Turndown-ised main content. Capped at 30k chars; the
     *  synthesis prompt only needs prose, and bigger payloads
     *  blow up the context budget for negligible gain. */
    contentMd: { type: String, default: '' },
    /**
     * SHA-256 of `contentMd` — stable across re-fetches when the
     * content hasn't changed. Lets the orchestrator skip embedding
     * on a refresh that returned 200 with identical body.
     */
    contentHash: { type: String, default: '' },
    fetchedAt: { type: Date, default: () => new Date() },
    /** TTL — Mongo auto-evicts the row after this date. Bumped
     *  forward on every successful re-fetch. */
    expiresAt: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 3600 * 1000) },
    /**
     * Embedding of `${title}\n${contentMd.slice(0, 8000)}`. Same
     * provider that embedded the user's pages, so cosine against
     * topic centroids is comparable. `select: false` follows the
     * Page.embedding convention — most call sites don't need the
     * vector and shouldn't pay to ship it.
     */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
    /**
     * Depth in the recursion frontier. 0 = pulled directly from a
     * search query; 1+ = harvested from links inside a higher-tier
     * doc. Phase 1 caps depth at 0 (no recursion); kept here so
     * Phase 2 doesn't need a schema change.
     */
    fetchDepth: { type: Number, default: 0 },
    /** When `fetchDepth > 0`, the URL of the parent we recursed from. */
    parentUrl: { type: String, default: null },
    /** Topic the user's research run was anchored on (e.g. "Iran").
     *  Used for cleanup + later cross-topic queries. */
    topicLabel: { type: String, default: '' },
    /** Page that triggered this fetch. null when the run was
     *  initiated from settings or a CLI tool. */
    triggeringPageId: { type: Schema.Types.ObjectId, ref: 'Page', default: null },
    /** Where the URL came from. Helps debugging and lets the UI
     *  group sources by discovery channel. */
    discoveredVia: {
      type: String,
      enum: ['searxng', 'rss', 'sitemap', 'recursion', 'manual'],
      default: 'searxng',
    },
    /** The query string SearXNG returned this URL for, when known. */
    searchQuery: { type: String, default: null },
    /**
     * False when robots.txt forbade us from fetching the body. We
     * still keep the row so the synthesis prompt can surface a
     * "see also" link and we don't re-attempt the fetch every run.
     * The `body`/`contentMd` are empty in that case.
     */
    robotsAllowed: { type: Boolean, default: true },
    /** HTTP cache validators stashed for conditional GETs. */
    etag: { type: String, default: null },
    lastModified: { type: String, default: null },
    /** Cosine similarity to the topic centroid at the time of fetch.
     *  0–1 range; below the per-user threshold means "off-topic"
     *  and the doc isn't fed to synthesis. */
    relevanceScore: { type: Number, default: 0 },
    offTopic: { type: Boolean, default: false },
  },
  { timestamps: true },
);

webDocumentSchema.index({ userId: 1, urlHash: 1 }, { unique: true });
webDocumentSchema.index({ userId: 1, triggeringPageId: 1 }, { sparse: true });
webDocumentSchema.index({ userId: 1, topicLabel: 1 });
// Web-research fetch path checks `(userId, hostKey, expiresAt > now)`
// to decide whether to re-fetch a host. The standalone hostKey
// index was a collscan on userId before this compound landed —
// the doc-comment near the top claimed the index existed but the
// schema.index() call was missing. Sparse on expiresAt because
// the TTL index below will drop rows once it expires anyway.
webDocumentSchema.index({ userId: 1, hostKey: 1, expiresAt: 1 });
// TTL index — Mongo evicts when expiresAt is in the past. Set
// `expireAfterSeconds: 0` so the index reads `expiresAt` literally
// rather than offsetting from it.
webDocumentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type WebDocumentDoc = HydratedDocument<InferSchemaType<typeof webDocumentSchema>> & {
  _id: Types.ObjectId;
};
export const WebDocument = model('WebDocument', webDocumentSchema);
