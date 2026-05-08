import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true },
    settings: {
      // Legacy fields kept for backwards compat; new code reads `providers`.
      defaultGenerationModel: { type: String, default: 'llama3.1:8b-instruct' },
      defaultEmbeddingModel: { type: String, default: 'nomic-embed-text' },
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      /**
       * Global default polling interval for RSS feeds (minutes). Per-feed
       * overrides take precedence; this is what new feeds default to.
       */
      rssPollIntervalMinutes: { type: Number, default: 30, min: 5, max: 1440 },
      /**
       * Hide promotional content (newsletters / ads) from the digest's
       * primary surfaces. Promotional pages still exist and are reachable
       * via Search, the Codex, and a dedicated "Promotions" view.
       */
      hidePromotions: { type: Boolean, default: true },
      /**
       * Render the current moon phase as a header icon on Home and as
       * a small glyph on each calendar day cell. Off by default; the
       * user opts in from Settings → Newsletter (display section).
       */
      showMoonPhases: { type: Boolean, default: false },
      /**
       * Topics / tags the user has muted from the home page's
       * "Trending topics" card. Stored lowercased; filtered out at
       * the digest endpoint so the topic still exists on its own
       * page but never bubbles to the trending widget. Useful for
       * boilerplate like "unsubscribe" or "privacy-policy" that
       * carry no editorial weight.
       */
      trendingBlocklist: { type: [String], default: [] },
      /**
       * When and where to mail the daily/weekly digest. Disabled by
       * default; the user opts in from Settings → Newsletter. We
       * schedule a coarse hourly worker that consults this struct
       * per-user instead of an actual per-user repeating job (cleaner
       * config story and tolerates timezone changes).
       */
      digestEmail: {
        enabled: { type: Boolean, default: false },
        toAddress: { type: String, default: null },
        cadence: { type: String, enum: ['daily', 'weekly'], default: 'daily' },
        /** 'HH:MM' local time. */
        timeOfDayLocal: { type: String, default: '08:00' },
        /** 0–6 (Sunday=0); only used for weekly. */
        weeklyDay: { type: Number, default: 1, min: 0, max: 6 },
        /** IANA timezone, e.g. 'America/Chicago'. */
        timezone: { type: String, default: 'UTC' },
        lastSentAt: { type: Date, default: null },
        lastError: { type: String, default: null },
      },
      /**
       * Cadence + scheduling for the LLM-written narrative briefing.
       * Lives as a Page (groupingMode='briefing') in the wiki — the
       * worker handles both writing it and scheduling it.
       */
      briefing: {
        enabled: { type: Boolean, default: false },
        cadence: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
        timeOfDayLocal: { type: String, default: '08:00' },
        /** 0–6 (Sunday=0). */
        dayOfWeek: { type: Number, default: 1, min: 0, max: 6 },
        timezone: { type: String, default: 'UTC' },
        lastGeneratedAt: { type: Date, default: null },
        lastError: { type: String, default: null },
      },
      /**
       * Opt-in read tracking. When off, /api/pages never writes
       * UserPageState rows on view, the unread-dot UI stays hidden,
       * and the home digest doesn't surface a "new since you last
       * visited" ribbon.
       */
      trackReads: { type: Boolean, default: false },
      /**
       * Vision describe-image config. Off by default — different
       * cost profile from text generation. When enabled the worker
       * runs the user's generation provider with `vision.model` (or
       * the role default) over images embedded in emails. `dailyCap`
       * is a hard ceiling on describe calls per UTC day.
       */
      vision: {
        enabled: { type: Boolean, default: false },
        model: { type: String, default: '' },
        dailyCap: { type: Number, default: 30, min: 1, max: 1000 },
      },
      /**
       * Maps (plan 11) — show OpenStreetMap pins for calendar
       * events and place entities mentioned on wiki pages. Off by
       * default so geocoding doesn't happen until the user opts
       * in, since each call sends a place-name string to Nominatim.
       */
      maps: {
        enabled: { type: Boolean, default: false },
        /** Set the first time the user accepts the egress note so
         *  the UI stops re-showing it. */
        lastAcknowledgedAt: { type: Date, default: null },
      },
      /**
       * Library — user-curated source corpus crawled, indexed, and
       * exposed both as a standalone search surface (/library) and
       * as a Daydream adapter so wiki-page Background notes can pull
       * from sources the user already trusts.
       */
      library: {
        enabled: { type: Boolean, default: false },
        /** Hard ceiling on documents fetched per UTC day. */
        dailyCrawlCap: { type: Number, default: 500, min: 10, max: 10000 },
        /** Whether the LibraryAdapter participates in Daydream. */
        useInDaydream: { type: Boolean, default: true },
      },
      /**
       * Daydream — opportunistic research enrichment that runs while
       * the rest of the pipeline is idle. Off by default; the user
       * sees a one-time egress explainer on first opt-in.
       */
      daydream: {
        enabled: { type: Boolean, default: false },
        /** 'idle' (when queues empty), 'daily' (cron), or 'off'. */
        schedule: { type: String, enum: ['idle', 'daily', 'off'], default: 'idle' },
        /** HH:MM local time for the daily cron. */
        dailyAtLocal: { type: String, default: '03:00' },
        timezone: { type: String, default: 'UTC' },
        /** Hard ceiling on synthesis LLM calls per UTC day. */
        dailyCallCap: { type: Number, default: 50, min: 1, max: 500 },
        /** Max subjects researched per page in one pass. */
        perPageMaxSubjects: { type: Number, default: 3, min: 1, max: 20 },
        /** Re-research a subject after this many days. */
        refreshAfterDays: { type: Number, default: 30, min: 1, max: 365 },
        sources: {
          wikipedia: {
            enabled: { type: Boolean, default: true },
            lang: { type: String, default: 'en' },
          },
          wiktionary: {
            enabled: { type: Boolean, default: false },
            lang: { type: String, default: 'en' },
          },
          /** Wikidata covers entities Wikipedia doesn't have articles
           *  for (companies, niche works, abstract concepts) — biggest
           *  single coverage gain in Tier 1 of plan 10. */
          wikidata: {
            enabled: { type: Boolean, default: false },
            lang: { type: String, default: 'en' },
          },
          /** OpenAlex — 250M+ scholarly works. The polite-pool mailto
           *  bumps the rate limit; falsy = anonymous tier. */
          openalex: {
            enabled: { type: Boolean, default: false },
            mailto: { type: String, default: '' },
          },
          /** Link-graph adapter walks the user's own pageLinks to
           *  surface URLs their corpus has already vouched for. No
           *  external fetch — pure Mongo aggregation. */
          linkGraph: {
            enabled: { type: Boolean, default: false },
            minHostCount: { type: Number, default: 2, min: 1, max: 10 },
          },
          stackexchange: {
            enabled: { type: Boolean, default: false },
            sites: { type: [String], default: ['stackoverflow'] },
            /** Optional API key (10K req/day vs 300/day anon). */
            apiKey: { type: String, default: '' },
          },
          arxiv: { enabled: { type: Boolean, default: false } },
          hackernews: { enabled: { type: Boolean, default: false } },
          /** Crossref — DOI metadata, polite-pool with mailto. */
          crossref: {
            enabled: { type: Boolean, default: false },
            mailto: { type: String, default: '' },
          },
          /** GitHub — public repo search, optional PAT bumps to 5K/h. */
          github: {
            enabled: { type: Boolean, default: false },
            token: { type: String, default: '' },
          },
        },
        /**
         * External search (Tier 4 of plan 10) — federated web-search
         * adapters that aren't structured-knowledge sources. Gated
         * behind a master toggle with a one-time egress
         * acknowledgement; even keyless adapters (Marginalia,
         * DuckDuckGo) only fire when the master is on. BYO-key
         * adapters (Brave) never aggregate the key — encrypted at
         * rest with the same AES-256-GCM helper as Anthropic/OpenAI.
         */
        externalSearch: {
          enabled: { type: Boolean, default: false },
          marginalia: { enabled: { type: Boolean, default: true } },
          duckduckgo: { enabled: { type: Boolean, default: true } },
          brave: {
            enabled: { type: Boolean, default: false },
            /** Subscription token, encrypted via crypto.encryptJson. */
            encryptedApiKey: { type: String, default: null, select: false },
          },
          searxng: {
            enabled: { type: Boolean, default: false },
            instanceUrl: { type: String, default: '' },
          },
        },
        skip: {
          senderBrandKeys: { type: [String], default: [] },
          tags: { type: [String], default: [] },
          categoryIds: { type: [Schema.Types.ObjectId], default: [] },
        },
        /**
         * Topic-research preferences (web-integration Phase 1).
         * Lives under `settings.daydream` (not directly under
         * `settings`) because every worker / API call site reads
         * from `settings.daydream.webResearch.*` — defining it
         * here aligns the schema with those paths so mongoose's
         * strict-mode write filter actually persists the field.
         * The /api/daydream PATCH handler writes
         * `settings.daydream.webResearch = {whole object}` which
         * is now a defined sub-path. Default `enabled: false` —
         * opting in requires an explicit toggle so the system
         * never crawls the web on a user's behalf without
         * acknowledgement. Daily fetch budget caps the per-user
         * outbound HTTP volume regardless of how many topics
         * queue up.
         */
        webResearch: {
          enabled: { type: Boolean, default: false },
          /** Per-user 24h fetch budget across all research runs. */
          dailyFetchBudget: { type: Number, default: 200 },
          /** Per-research-run hard cap on number of fetches. */
          perRunFetchBudget: { type: Number, default: 25 },
          /** Per-research-run wall-clock cap, milliseconds. */
          perRunTimeoutMs: { type: Number, default: 5 * 60_000 },
          /** Cosine threshold for keeping fetched docs in-corpus. */
          topicThreshold: { type: Number, default: 0.55 },
          /** Hostnames the user explicitly never wants research to
           *  pull from. Compared as a suffix match on the eTLD+1. */
          denyHosts: { type: [String], default: [] },
        },
      },
    },
    /**
     * Per-user provider configuration. API keys are stored encrypted via
     * the same AES-256-GCM helper as Source.encryptedConfig — never echoed
     * back to the client.
     */
    providers: {
      generation: {
        provider: {
          type: String,
          enum: ['ollama', 'anthropic', 'openai'],
          default: 'ollama',
        },
        model: { type: String, default: 'llama3.1:8b-instruct' },
        /**
         * Where to run the model on Ollama. `auto` lets Ollama decide
         * based on free VRAM; `gpu` pins all layers to the GPU;
         * `cpu` pins everything to CPU (useful for small embedding
         * models so the gen model has the GPU to itself). Ignored by
         * Anthropic / OpenAI — their inference is remote.
         */
        device: {
          type: String,
          enum: ['auto', 'gpu', 'cpu'],
          default: 'auto',
        },
        /**
         * Optional sampling overrides for every generate-page-style call.
         * Anything left null falls back to the per-call default in the
         * worker (0.2 for JSON mode, 0.4 for narrative writes). topK,
         * repeatPenalty, and numCtx are Ollama-only — silently ignored
         * by Anthropic/OpenAI. maxTokens maps to num_predict / max_tokens.
         */
        params: {
          temperature: { type: Number, default: null, min: 0, max: 2 },
          maxTokens: { type: Number, default: null, min: 1, max: 32768 },
          topP: { type: Number, default: null, min: 0, max: 1 },
          topK: { type: Number, default: null, min: 1, max: 200 },
          repeatPenalty: { type: Number, default: null, min: 0, max: 4 },
          numCtx: { type: Number, default: null, min: 512, max: 131072 },
        },
      },
      embedding: {
        provider: { type: String, enum: ['ollama', 'openai'], default: 'ollama' },
        model: { type: String, default: 'nomic-embed-text' },
        device: {
          type: String,
          enum: ['auto', 'gpu', 'cpu'],
          default: 'auto',
        },
      },
      ollama: {
        /** Default Ollama endpoint when no role-specific override is set. */
        baseUrl: { type: String, default: '' },
        /** Per-role overrides — let users dedicate one Ollama instance to
         *  generation, another to embeddings, another to vision (e.g.
         *  pinned to different GPUs). Falls back to `baseUrl`, then env. */
        generationBaseUrl: { type: String, default: '' },
        embeddingBaseUrl: { type: String, default: '' },
        visionBaseUrl: { type: String, default: '' },
      },
      anthropic: {
        encryptedApiKey: { type: String, default: null, select: false },
        baseUrl: { type: String, default: '' },
      },
      openai: {
        encryptedApiKey: { type: String, default: null, select: false },
        baseUrl: { type: String, default: '' },
      },
    },
    /**
     * Pinned saved searches. Each entry is a named query the user
     * has stashed for quick recall — surfaced in the sidebar as a
     * smart folder when `pinned` is true. Notify hooks into the
     * push-notification rules pipeline.
     */
    savedSearches: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            name: { type: String, required: true },
            query: { type: String, default: '' },
            filters: {
              tags: { type: [String], default: [] },
              senders: { type: [String], default: [] },
              priority: { type: [String], default: [] },
              flag: {
                isPromotional: { type: Boolean, default: undefined },
                isNotificationStream: { type: Boolean, default: undefined },
                userMarkedSpam: { type: Boolean, default: undefined },
              },
              dateRange: {
                since: { type: Date, default: null },
                until: { type: Date, default: null },
              },
            },
            pinned: { type: Boolean, default: false },
            notify: { type: String, enum: ['never', 'on-new-match'], default: 'never' },
            createdAt: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * User-curated spam policy. Membership in any of these lists is enough
     * to mark a wiki page (and its source emails) as spam, distinct from the
     * heuristic `flags.hasLikelySpam`.
     *
     * `blockedSenders` is stronger than `senders`: the worker drops the
     * message before it ever becomes an Email row, so it never makes it
     * into the wiki. Useful for known spammers / mass-mailers the user
     * doesn't even want to see in /quarantine.
     */
    spamPolicy: {
      senders: { type: [String], default: [], index: true },
      tags: { type: [String], default: [], index: true },
      blockedSenders: { type: [String], default: [], index: true },
      /** User-trusted senders that bypass the blocklist, the
       *  Bayes spam classifier, and the auto-quarantine sweep.
       *  Stored lowercased; entries can be a full address
       *  (`alice@example.gov`), a host (`example.gov`), or a
       *  bare domain that the eTLD+1 matcher will collapse to.
       *  All `.gov` and `.edu` senders are implicitly whitelisted
       *  regardless of this list — see `isSenderWhitelisted` in
       *  @rose/email-parser. */
      whitelistedSenders: { type: [String], default: [], index: true },
    },
    /**
     * Tags the user wants foregrounded in the newsletter — each becomes
     * a named section above the latest-news time buckets. Order matters
     * (the array order is the section order in the UI).
     */
    featuredTags: { type: [String], default: [] },
    /**
     * Saved locations for the home-page weather widget. Order matters
     * (first becomes the default if no `primary` flag is set, the UI
     * promotes/demotes by editing the array). Each row gets a stable
     * sub-document _id so the API can reference one by id.
     */
    weatherLocations: {
      type: [
        new Schema(
          {
            lat: { type: Number, required: true },
            lon: { type: Number, required: true },
            label: { type: String, required: true },
            primary: { type: Boolean, default: false },
            setAt: { type: Date, default: () => new Date() },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    /**
     * Retention windows (in days). The cleanup worker consults these
     * nightly and deletes data older than the configured age in each
     * collection. `0` means "keep forever". Defaults are conservative
     * — most users won't notice them, but a busy mailbox will.
     *
     * The fields aren't gated behind an "enabled" toggle; the worker
     * only touches collections whose setting is > 0, and `0` is the
     * disable sentinel. This keeps the settings UI dead simple
     * (number inputs in days) without a parallel boolean for each.
     */
    retention: {
      /** Email rows + their attachments. */
      emails: { type: Number, default: 365, min: 0, max: 3650 },
      /** Per-page revision history (oldest revisions pruned first;
       *  the latest revision is always retained). */
      pageRevisions: { type: Number, default: 180, min: 0, max: 3650 },
      /** Daydream encyclopedia notes. */
      daydream: { type: Number, default: 90, min: 0, max: 3650 },
      /** Recipe firing audit log. */
      recipeAudit: { type: Number, default: 30, min: 0, max: 365 },
      /** Chat conversations + messages — older threads dropped. */
      conversations: { type: Number, default: 365, min: 0, max: 3650 },
      /** Per-day-per-tag digest snippets. */
      tagDigests: { type: Number, default: 60, min: 0, max: 365 },
      /** Snapshotted weather forecasts. */
      weatherSnapshots: { type: Number, default: 30, min: 0, max: 365 },
      /** Email vector embeddings. Once dropped the email is still
       *  searchable via Mongo text index; only semantic search loses
       *  it. Defaults to dropping older than 6 months. */
      emailEmbeddings: { type: Number, default: 180, min: 0, max: 3650 },
      /** Page rows. Almost everyone wants articles forever — the
       *  default is "keep all" (0), but power users with very large
       *  archives can opt in. */
      pages: { type: Number, default: 0, min: 0, max: 3650 },
      /** When set, Email.text + html columns are nulled out for any
       *  email older than this AND that already produced a Page —
       *  the article preserves the gist while the raw body shrinks
       *  to its hash + headers. Only the body is stripped; the row
       *  itself stays so backlinks (page.sourceEmailIds) still
       *  resolve. */
      stripOldEmailBodiesDays: { type: Number, default: 0, min: 0, max: 3650 },
      /** Last completed cleanup run, surfaced in the settings UI. */
      lastCleanupAt: { type: Date, default: null },
      /** Last cleanup result (counts per collection) for the UI. */
      lastCleanupSummary: { type: Schema.Types.Mixed, default: null },
    },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
