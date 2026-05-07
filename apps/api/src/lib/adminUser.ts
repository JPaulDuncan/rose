import { Types } from 'mongoose';
import { User } from '@rose/db';
import { env } from './env.js';

/**
 * Resolve the deployment's admin user. Models / providers configuration
 * is centralised on this single user so every other account shares one
 * global LLM stack — switching between Ollama and Anthropic, picking a
 * generation model, etc., happens once for everyone.
 *
 * Cached for five minutes so the lookup isn't paid on every API
 * call. The cache is invalidated implicitly on TTL expiry; an admin
 * email change in env propagates within five minutes without a
 * restart.
 */
let cached: { id: Types.ObjectId; expiresAt: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export async function adminUserId(): Promise<Types.ObjectId | null> {
  if (!env.ADMIN_EMAIL) return null;
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.id;
  const u = await User.findOne({ email: env.ADMIN_EMAIL })
    .select('_id')
    .lean();
  if (!u) return null;
  cached = { id: u._id as Types.ObjectId, expiresAt: now + TTL_MS };
  return cached.id;
}

export function clearAdminUserCache(): void {
  cached = null;
}
