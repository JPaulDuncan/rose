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
