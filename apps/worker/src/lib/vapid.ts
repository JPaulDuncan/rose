import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Resolve VAPID keys: env vars win; otherwise fall back to a key
 * file in `var/vapid.json`, generating one on first boot. Both API
 * and worker call this and reach the same keypair as long as they
 * share the var/ volume (which they do in the standard compose setup).
 */
const VAPID_FILE = path.resolve(process.cwd(), 'var', 'vapid.json');

let cached: { publicKey: string; privateKey: string; subject: string } | null = null;

export function getVapidKeys(): { publicKey: string; privateKey: string; subject: string } {
  if (cached) return cached;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    cached = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    };
    webpush.setVapidDetails(cached.subject, cached.publicKey, cached.privateKey);
    return cached;
  }
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      cached = {
        publicKey: raw.publicKey,
        privateKey: raw.privateKey,
        subject: raw.subject ?? env.VAPID_SUBJECT,
      };
      webpush.setVapidDetails(cached.subject, cached.publicKey, cached.privateKey);
      return cached;
    } catch (err) {
      logger.warn({ err }, 'vapid: failed to load key file; regenerating');
    }
  }
  // Generate a fresh keypair and persist.
  const k = webpush.generateVAPIDKeys();
  cached = { publicKey: k.publicKey, privateKey: k.privateKey, subject: env.VAPID_SUBJECT };
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(cached, null, 2), {
      mode: 0o600,
    });
    logger.info({ path: VAPID_FILE }, 'vapid: generated new keypair');
  } catch (err) {
    logger.warn({ err }, 'vapid: keys not persisted (volume read-only?)');
  }
  webpush.setVapidDetails(cached.subject, cached.publicKey, cached.privateKey);
  return cached;
}

export { webpush };
