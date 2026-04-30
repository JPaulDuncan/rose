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
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);
