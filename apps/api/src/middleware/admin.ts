import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '@rose/db';
import { env } from '../lib/env.js';
import { userIdOf } from './auth.js';

/**
 * Plan 16 — admin gate. Compares the current user's email
 * (case-insensitive) against `env.ADMIN_EMAIL`. The match is
 * resolved per-request rather than cached, so an admin email
 * change in env propagates without restart (next request just
 * reads the new env value, same User row).
 *
 * Mounted only on routes that perform destructive operations
 * (currently `/api/admin/*`). 401 → 403 distinction:
 *   • 401 from the parent `requireAuth` covers missing token.
 *   • 403 from this middleware covers "authenticated, but not
 *     admin" so the SPA can show a meaningful denial.
 *   • 404 when ADMIN_EMAIL is empty — disables the surface
 *     entirely so a misconfigured deploy doesn't leak the
 *     existence of admin endpoints.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!env.ADMIN_EMAIL) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const user = await User.findById(new Types.ObjectId(userId)).select('email').lean();
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if ((user.email ?? '').toLowerCase() !== env.ADMIN_EMAIL) {
    res.status(403).json({
      error: 'forbidden',
      message: 'Admin operations are restricted.',
    });
    return;
  }
  next();
}

/**
 * Cheap predicate for callers that just need to know whether the
 * current request is from the admin (without short-circuiting the
 * response themselves).
 */
export async function isAdminRequest(req: Request): Promise<boolean> {
  if (!env.ADMIN_EMAIL) return false;
  let userId: string;
  try {
    userId = userIdOf(req);
  } catch {
    return false;
  }
  const user = await User.findById(new Types.ObjectId(userId)).select('email').lean();
  return (user?.email ?? '').toLowerCase() === env.ADMIN_EMAIL;
}
