import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  MONGO_URI: required('MONGO_URI', 'mongodb://mongo:27017/rose'),
  REDIS_URL: required('REDIS_URL', 'redis://redis:6379'),
  OLLAMA_URL: required('OLLAMA_URL', 'http://ollama:11434'),
  ENCRYPTION_KEY: required('ENCRYPTION_KEY', 'dev-only-encryption-key-32bytes!!'),
  DEFAULT_GENERATION_MODEL: process.env.DEFAULT_GENERATION_MODEL ?? 'llama3.1:8b-instruct',
  DEFAULT_EMBEDDING_MODEL: process.env.DEFAULT_EMBEDDING_MODEL ?? 'nomic-embed-text',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? '',
  /** WebPush VAPID keypair. Auto-generated on first boot if absent
   *  and persisted to a file under var/. The public half is exposed
   *  to the SPA via /api/push/key. */
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? 'mailto:admin@rose.local',
} as const;
