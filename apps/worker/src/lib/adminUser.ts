import { Types } from 'mongoose';
import { User } from '@rose/db';
import { env } from './env.js';

/**
 * Resolve the deployment's admin user. Models / providers config is
 * centralised on this user so worker jobs read from one global stack
 * rather than the email-owner's own settings.
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
