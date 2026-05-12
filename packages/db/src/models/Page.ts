import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const pageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    slug: { type: String, required: true },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    contentMd: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    sourceEmailIds: { type: [Schema.Types.ObjectId], default: [] },
    backlinks: { type: [Schema.Types.ObjectId], default: [] },
    /**
     * Multiple thread identifiers can roll up into one page when the topic
     * spans threads (e.g. weekly digests with different Message-IDs).
     * Indexed for fast lookup during email→page assignment.
     */
    threadKeys: { type: [String], default: [], index: true },
    /** Canonical sender addresses contributing to this page (lowercased). */
    senderAddresses: { type: [String], default: [], index: true },
    /**
     * Subject templates (output of `extractSubjectTemplate`) of the
     * messages on this page. Templated notifications from the same sender
     * (CI failures, receipts, daily digests) collapse onto one page via
     * an exact subjectTemplate hit before any embedding-based path runs.
     */
    subjectTemplates: { type: [String], default: [], index: true },
    /**
     * Why this email landed on this page, recorded for transparency in the UI.
     * `thread` = matched an existing threadKey
     * `source-topic` = matched on sender + cosine similarity above threshold
     * `manual` = user-edited
     */
    groupingMode: {
      type: String,
      enum: ['thread', 'source-topic', 'topic', 'manual', 'briefing', 'synthesis'],
      default: 'thread',
    },
    /**
     * For pages produced by synthesis or briefings — tracks the source
     * pages that fed into them. Surfaced in the UI as "drew from" and
     * lets us offer a "re-synthesize" action when the underlying pages
     * change.
     */
    synthesisOf: { type: [Schema.Types.ObjectId], default: [] },
    /**
     * Backreference to the Recipe that produced this page, when
     * applicable. Set on Topic Watch briefings so subsequent runs of
     * the same watch update the existing page rather than spawning a
     * new one each cron tick. Sparse-indexed; null for everything
     * else.
     */
    recipeId: { type: Schema.Types.ObjectId, ref: 'Recipe', default: null },
    /**
     * Non-email source list for pages produced by Daydream-style
     * briefings (Topic Watches). Each entry is a snippet that fed
     * the LLM, surfaced as a "Sources" card on the page so inline
     * `[n]` citation markers in the body resolve to clickable URLs.
     * Email-derived pages keep using `citations` + `sourceEmailIds`;
     * the two paths don't collide because the right-rail card uses
     * whichever array is populated.
     */
    externalSources: {
      type: [
        new Schema(
          {
            /** Display index — "1", "2", etc. — matches the inline
             *  citation marker the LLM emits. */
            label: { type: String, required: true },
            title: { type: String, default: '' },
            url: { type: String, required: true },
            /** Daydream adapter id ('wikipedia', 'duckduckgo', …)
             *  for grouping / display. */
            adapter: { type: String, default: null },
            fetchedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * For `groupingMode === 'topic'` pages (currently RSS-fed). The
     * canonical topic/tag this page is anchored on. Lowercased, stable —
     * the assignment service uses this to find an existing topic page
     * when a new RSS item arrives.
     */
    primaryTopic: { type: String, default: null, index: true },
    /**
     * Synonyms / alternate phrasings the LLM has emitted for the same
     * underlying story (e.g. "Iran war", "Iran-Israel conflict"). Used
     * by the cross-sender topic matcher so a follow-up email mentioning
     * "Iran-Israel conflict" still routes to the existing "War in Iran"
     * page. Lowercased.
     */
    topicAliases: { type: [String], default: [], index: true },
    /**
     * Snapshot of `sourceEmailIds` at the moment the LLM last (re)wrote
     * `contentMd`. Incremental generation diffs the live list against
     * this to discover which emails are genuinely new since the last
     * pass — the merge prompt only sees those, not the whole corpus.
     */
    lastGeneratedFromEmailIds: { type: [Schema.Types.ObjectId], default: [] },
    /**
     * Generation strategy:
     *   'rebuild'    — regenerate `contentMd` from all sources every
     *                  time. Cheap, idempotent. Default for thread,
     *                  source-template, and source-topic pages.
     *   'incremental' — feed the LLM the existing `contentMd` plus only
     *                   the new emails. Used for cross-sender topic
     *                   pages so a long-running story page evolves
     *                   without rewriting the whole article (which
     *                   would also clobber the user's manual edits).
     */
    generationMode: {
      type: String,
      enum: ['rebuild', 'incremental'],
      default: 'rebuild',
      index: true,
    },
    /**
     * Average of source-email embeddings — used to decide whether a new
     * email is on-topic enough to merge here. Deselect by default; cosine
     * comparison happens at assignment time.
     */
    topicCentroid: { type: [Number], default: null, select: false },
    /** Inline citation map: { e1: { emailId, subject, from, date }, e2: ... } */
    citations: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    /** Highest priority across contributing emails. */
    priority: {
      type: String,
      enum: ['high', 'normal', 'low'],
      default: 'normal',
      index: true,
    },
    /** True when the user manually overrode the article's priority via
     *  the page header control. Generation honours the override (won't
     *  re-derive priority from email headers). Cleared when the user
     *  resets to "auto". */
    priorityOverride: { type: Boolean, default: false },
    /**
     * Newspaper-style article date — the date the story actually
     * happened, sourced from the latest contributing email's `date`
     * (received timestamp, falling back to its createdAt). Distinct
     * from Mongoose's `createdAt` which is when the Page row was
     * inserted. UI sorts and headlines use this so an article filed
     * from a 3-day-old email sorts under that day, not today.
     */
    articleDate: { type: Date, default: null, index: true },
    /** Union of email topics (capitalized phrases / hashtags), deduped. */
    topics: { type: [String], default: [], index: true },
    /** Aggregated links across emails. */
    pageLinks: {
      type: [
        new Schema(
          {
            url: { type: String, required: true },
            text: { type: String, default: null },
            count: { type: Number, default: 1 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Rolled-up image URLs across the page's source emails. */
    pageImages: {
      type: [
        new Schema(
          {
            url: { type: String, required: true },
            alt: { type: String, default: null },
            description: { type: String, default: null },
            count: { type: Number, default: 1 },
            fromEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** A representative image surfaced as a hero banner on the wiki page. */
    heroImageUrl: { type: String, default: null },
    /** Rolled-up attachments with the email each came from for back-reference. */
    pageAttachments: {
      type: [
        new Schema(
          {
            filename: { type: String, default: '' },
            contentType: { type: String, default: '' },
            size: { type: Number, default: 0 },
            fromEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Max spamScore across contributing emails (0..1). */
    spamScore: { type: Number, default: 0, index: true },
    /** Page-level flags surfaced in the UI. */
    flags: {
      hasLikelySpam: { type: Boolean, default: false },
      hasMassMailing: { type: Boolean, default: false },
      isSparse: { type: Boolean, default: false },
      /** Set when the user (not the heuristic) flags a page as spam. */
      userMarkedSpam: { type: Boolean, default: false },
      /** Set when ≥70% of contributing emails share one subject template. */
      isNotificationStream: { type: Boolean, default: false, index: true },
      /** Set when the contributing emails roll up as promotional content. */
      isPromotional: { type: Boolean, default: false, index: true },
      /** Set by the sender-reputation loop when the brand has accumulated
       *  enough user spam-marks to warrant auto-quarantining future mail.
       *  Distinct from `userMarkedSpam` so the user can see *why* it was
       *  hidden and rescue with one click. */
      autoQuarantined: { type: Boolean, default: false, index: true },
    },
    /** Legacy single-thread field — kept for migration. New code uses threadKeys. */
    threadKey: { type: String, default: null },
    version: { type: Number, default: 1 },
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
    /** Provider:model that authored the current contentMd
     *  (e.g. "ollama:llama3.1:8b-instruct" or
     *  "anthropic:claude-haiku-4-5-20251001"). Surfaced on the page
     *  view as a provenance footer. Null for hand-edited pages. */
    generationModel: { type: String, default: null },
    /** When the current contentMd was last (re)written by the LLM. */
    generatedAt: { type: Date, default: null },
    /**
     * Discriminator for who wrote the current revision:
     *   'llm'   — produced by generatePage from contributing emails
     *   'synth' — produced by /api/pages/synthesize from other pages
     *   'briefing' — produced by the weekly briefing worker
     *   'human' — saved manually via the editor (PATCH /api/pages)
     * Null = legacy rows from before this field was added.
     */
    generatedBy: {
      type: String,
      enum: ['llm', 'synth', 'briefing', 'human', null],
      default: null,
    },
    /**
     * Candidate pages this one might be a duplicate of. Produced by
     * the merge-detection step that runs after each page write — it
     * finds nearby pages by cosine similarity and runs the
     * `dedupe.detect` LLM check over the top candidates. Surfaced in
     * the UI as a "Potential duplicate of …" banner with merge /
     * dismiss buttons so the user makes the final call. Dismissals
     * are recorded so the same suggestion doesn't keep coming back.
     */
    mergeSuggestions: {
      type: [
        new Schema(
          {
            pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
            score: { type: Number, required: true, min: 0, max: 1 },
            reason: { type: String, default: '' },
            suggestedAt: { type: Date, default: () => new Date() },
            dismissedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * Subjects (topics / entities / sender brands / tags) the daydream
     * worker has decided this page wants encyclopedic context for.
     * Notes themselves live in the DaydreamNote collection — this is
     * just the back-reference so the page view can fetch them in a
     * single $in query and the worker knows what to refresh.
     */
    /**
     * Place entities extracted from the page body, with optional
     * geocoded coordinates. Populated when the user has Settings →
     * Maps enabled (plan 11). Pre-geocoding entries have name +
     * normKey but null lat/lon; failed geocodes set `failed: true`
     * to avoid retry storms.
     */
    places: {
      type: [
        new Schema(
          {
            name: { type: String, required: true, maxlength: 200 },
            /** Lowercased + collapsed key for dedup. */
            normKey: { type: String, required: true, maxlength: 200 },
            lat: { type: Number, default: null, min: -90, max: 90 },
            lon: { type: Number, default: null, min: -180, max: 180 },
            displayName: { type: String, default: null },
            geocodedAt: { type: Date, default: null },
            failed: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * Hash of the contentMd at the time we last ran place extraction,
     * so we can skip the LLM call when the page body hasn't moved.
     */
    placesExtractedFromHash: { type: String, default: null },
    /**
     * Named entities extracted from the page body — people, works
     * (movies, shows, books, songs, articles), and organizations.
     * Each entry is rendered as a clickable link in the prose
     * (auto-linker matches `displayName` and any persisted aliases)
     * and surfaced in the right-rail "Mentions" card. Routing target
     * is `/n/<normKey>` regardless of type.
     */
    entities: {
      type: [
        new Schema(
          {
            name: { type: String, required: true, maxlength: 200 },
            /** Kebab-case lookup key, used as the URL slug. */
            normKey: { type: String, required: true, maxlength: 200, index: true },
            type: {
              type: String,
              enum: ['person', 'work', 'organization', 'place'],
              required: true,
            },
            /** Display form preserved from the LLM output ("Wait
             *  Wait... Don't Tell Me!"). Falls back to `name`. */
            displayName: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Content-hash gate for entity extraction; same idempotent
     *  pattern as `placesExtractedFromHash`. */
    entitiesExtractedFromHash: { type: String, default: null },
    /** Content-hash gate for typed-relation extraction. Same
     *  idempotent pattern: the worker computes sha256(contentMd)
     *  and skips when this field already matches. */
    relationsExtractedFromHash: { type: String, default: null },
    /** Content-hash gate for subscription extraction. */
    subscriptionExtractedFromHash: { type: String, default: null },
    daydreamSubjects: {
      type: [
        new Schema(
          {
            kind: {
              type: String,
              enum: ['topic', 'sender', 'tag', 'entity'],
              required: true,
            },
            subjectKey: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * Topic-research state machine (web-integration Phase 1).
     *
     *   • `idle`     — never researched, or last run completed.
     *   • `queued`   — a topicResearch job is on the queue.
     *   • `running`  — the orchestrator picked the job up.
     *   • `failed`   — the last run threw; reason on `lastResearchError`.
     *
     * The UI's "Research" button reads this to gate enqueues (no
     * point queueing a second run while one's already in flight)
     * and renders the "Researched <relative time>" pill from
     * `lastResearchedAt`.
     */
    researchState: {
      type: String,
      enum: ['idle', 'queued', 'running', 'failed'],
      default: 'idle',
    },
    lastResearchedAt: { type: Date, default: null },
    lastResearchError: { type: String, default: null },
    /**
     * WebDocument refs harvested by the most recent topic-research
     * run. Same role as `sourceEmailIds` for the email path; the
     * synthesis prompt cites them as `[w1]`, `[w2]`, … and the
     * right-rail `<ExternalSourcesSection>` joins on these to
     * render the citation list.
     */
    webDocumentIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      ref: 'WebDocument',
    },
    /**
     * Slugs of other pages this page's contentMd links to via
     * `/p/<slug>` references. Populated at write time so the
     * lineage endpoint can answer "what pages cite this one?" via
     * an indexed `$in` lookup instead of a contentMd regex scan
     * across every page (the old hot-path that motivated this
     * field). Stored sparse — most pages cite zero other pages.
     */
    outboundLinks: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

pageSchema.index({ userId: 1, slug: 1 }, { unique: true });
pageSchema.index({ userId: 1, threadKey: 1 });
pageSchema.index(
  { userId: 1, recipeId: 1 },
  { sparse: true },
);
// Category-rollup aggregation in generatePage runs `Page.aggregate
// [{$match: {userId, categoryId: {$ne: null}}}, {$group: ...}]` on
// every page generation. Without this it's a collscan; with it,
// the $match phase is fully covered.
pageSchema.index(
  { userId: 1, categoryId: 1 },
  { partialFilterExpression: { categoryId: { $type: 'objectId' } } },
);
// Spam-trust + sender-deletion queries hit `senderAddresses`. The
// array semantics mean Mongo builds a multikey index — fine for
// our scale (per-page address counts are small).
pageSchema.index({ userId: 1, senderAddresses: 1 });
// Tag-page lookups (Tag.tsx, recipe page-find by tag).
pageSchema.index({ userId: 1, tags: 1 });
// Lineage "cited-by" lookups — the previous regex over contentMd
// is now `outboundLinks: <slug>`, which this multikey index
// covers.
pageSchema.index({ userId: 1, outboundLinks: 1 });
pageSchema.index(
  { title: 'text', summary: 'text', contentMd: 'text', tags: 'text' },
  { weights: { title: 10, summary: 5, tags: 3, contentMd: 1 }, name: 'PageTextIndex' },
);

export type PageDoc = HydratedDocument<InferSchemaType<typeof pageSchema>> & {
  _id: Types.ObjectId;
};
export const Page = model('Page', pageSchema);
