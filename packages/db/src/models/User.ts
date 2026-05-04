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
      },
      embedding: {
        provider: { type: String, enum: ['ollama', 'openai'], default: 'ollama' },
        model: { type: String, default: 'nomic-embed-text' },
      },
      ollama: {
        baseUrl: { type: String, default: '' },
      },
      anthropic: {
        encryptedApiKey: { type: String, default: null, select: false },
        baseUrl: { type: String, default: '' },
      },
      openai: {
        encryptedApiKey: { type: String, default: null, select: false },
        baseUrl: { type: String, default: '' },
      },
      /**
       * Vision is opt-in per user — different cost profile from text
       * generation. When enabled, the inline-image describer uses the
       * generation provider with the configured `vision.model`
       * (defaults to a cheap mini model on each provider).
       */
      vision: {
        enabled: { type: Boolean, default: false },
        model: { type: String, default: '' },
        /** Daily cap on describe-image calls per user. Hard ceiling
         *  to keep metered providers from running up bills. */
        dailyCap: { type: Number, default: 30, min: 1, max: 1000 },
      },
    },
    /**
     * User-curated spam policy. Membership in any of these lists is enough
     * to mark a wiki page (and its source emails) as spam, distinct from the
     * heuristic `flags.hasLikelySpam`.
     */
    spamPolicy: {
      senders: { type: [String], default: [], index: true },
      tags: { type: [String], default: [], index: true },
    },
    /**
     * Tags the user wants foregrounded in the newsletter — each becomes
     * a named section above the latest-news time buckets. Order matters
     * (the array order is the section order in the UI).
     */
    featuredTags: { type: [String], default: [] },
    /** Optional location for the newsletter weather widget. */
    weatherLocation: {
      lat: { type: Number, default: null },
      lon: { type: Number, default: null },
      label: { type: String, default: null },
      setAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
