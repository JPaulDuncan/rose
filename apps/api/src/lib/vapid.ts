import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

const VAPID_FILE = path.resolve(process.cwd(), 'var', 'vapid.json');

let cached: { publicKey: string; privateKey: string; subject: string } | null = null;

/**
 * Resolve the active VAPID public key for the SPA. Mirrors the
 * worker's lookup — env vars win; otherwise read the key file the
 * worker generated at boot. The API never *generates* keys (the
 * worker does); when the file is missing, callers get null and
 * disable push features in the UI.
 */
export function getVapidPublicKey(): string | null {
  if (cached) return cached.publicKey;
  if (env.VAPID_PUBLIC_KEY) {
    cached = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    };
    return cached.publicKey;
  }
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      cached = raw;
      return raw.publicKey ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
