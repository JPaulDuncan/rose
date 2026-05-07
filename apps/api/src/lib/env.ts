import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 4000),
  MONGO_URI: required('MONGO_URI', 'mongodb://mongo:27017/rose'),
  REDIS_URL: required('REDIS_URL', 'redis://redis:6379'),
  OLLAMA_URL: required('OLLAMA_URL', 'http://ollama:11434'),
  JWT_SECRET: required('JWT_SECRET', 'dev-only-secret-change-me'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET', 'dev-only-refresh-secret-change-me'),
  ENCRYPTION_KEY: required('ENCRYPTION_KEY', 'dev-only-encryption-key-32bytes!!'),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? '',
  DEFAULT_GENERATION_MODEL: process.env.DEFAULT_GENERATION_MODEL ?? 'llama3.1:8b-instruct',
  DEFAULT_EMBEDDING_MODEL: process.env.DEFAULT_EMBEDDING_MODEL ?? 'nomic-embed-text',
  ENABLE_REGISTRATION: (process.env.ENABLE_REGISTRATION ?? 'true') === 'true',
  /**
   * Server-side idle-logout timeout in minutes. Pairs with the
   * client-side `VITE_IDLE_TIMEOUT_MINUTES` so a stolen access JWT
   * stops working at the same boundary the SPA gives up. Set 0 (or
   * negative) to disable server-side enforcement entirely. Default
   * 5 minutes — matches the SPA default.
   */
  IDLE_TIMEOUT_MINUTES: Number(process.env.IDLE_TIMEOUT_MINUTES ?? 5),
  /**
   * Email of the user with operator-mode access — sees the
   * Settings → Admin tab and can wipe corpora via
   * /api/admin/reset. Compared case-insensitively against
   * `User.email`. Defaults to `jpaulduncan@gmail.com`; set to
   * empty string to disable the admin surface entirely.
   */
  ADMIN_EMAIL: (process.env.ADMIN_EMAIL ?? 'jpaulduncan@gmail.com')
    .trim()
    .toLowerCase(),
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? 'mailto:admin@rose.local',
  /**
   * Where to spool incoming GGUF uploads before pushing them to
   * Ollama's blob endpoint. Defaults to the OS temp dir; override
   * if /tmp doesn't have enough room for 10+ GB models.
   */
  GGUF_UPLOAD_DIR: process.env.GGUF_UPLOAD_DIR ?? '',
} as const;

export type Env = typeof env;
