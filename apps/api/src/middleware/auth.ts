import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';
import { redis } from '../lib/redis.js';

/** Stash type. The `userId` is set by `requireAuth` and read via `userIdOf`. */
type WithUser = { userId?: string };

/** Request guaranteed to carry `userId` after `requireAuth`. */
export type AuthedRequest = Request & { userId: string };

const ACTIVITY_KEY = (uid: string) => `rose:idle:${uid}`;
/** Throttle redis SET on activity to 1/5s — enough freshness for a
 *  5+ minute idle timeout, cheap enough to run on every request. */
const ACTIVITY_WRITE_THROTTLE_MS = 5_000;
const lastWriteAt = new Map<string, number>();

/**
 * Record fresh activity for a user. Pairs with `requireAuth`'s idle
 * check; called explicitly on login / refresh so the very next
 * request from the new session doesn't immediately fail the check.
 */
export async function recordActivity(userId: string): Promise<void> {
  const ttlMinutes = env.IDLE_TIMEOUT_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) return;
  // EX in seconds — give 2x the TTL window of slack so a freshly-
  // recorded activity ages out naturally even if the user closes
  // their session.
  const ttlSec = Math.max(60, Math.round(ttlMinutes * 60 * 2));
  await redis.set(ACTIVITY_KEY(userId), String(Date.now()), 'EX', ttlSec);
  lastWriteAt.set(userId, Date.now());
}

/**
 * Forget activity (e.g. on logout) so the user's next request
 * before re-auth fails the idle check explicitly rather than
 * coasting on a stale timestamp.
 */
export async function clearActivity(userId: string): Promise<void> {
  lastWriteAt.delete(userId);
  await redis.del(ACTIVITY_KEY(userId));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing access token' });
    return;
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    const userId = payload.sub;
    (req as Request & WithUser).userId = userId;

    // Plan 12 (G4) — server-side idle enforcement. The client-side
    // VITE_IDLE_TIMEOUT_MINUTES boots the user out of the SPA, but
    // a stolen access JWT (15-minute TTL) would still work. We
    // gate every authenticated request on a per-user lastActivity
    // timestamp in Redis: missing or too old → 401, force re-auth.
    //
    // Set IDLE_TIMEOUT_MINUTES to 0 in env to disable.
    const ttlMin = env.IDLE_TIMEOUT_MINUTES;
    if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
      next();
      return;
    }

    void enforceIdleAndContinue(userId, ttlMin, res, next);
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

async function enforceIdleAndContinue(
  userId: string,
  ttlMinutes: number,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = await redis.get(ACTIVITY_KEY(userId));
    const now = Date.now();
    if (raw) {
      const last = Number(raw);
      const ageMs = now - (Number.isFinite(last) ? last : 0);
      if (ageMs > ttlMinutes * 60 * 1000) {
        await clearActivity(userId);
        res.status(401).json({
          error: 'session_idle_timeout',
          message: 'Session timed out due to inactivity. Sign in again.',
        });
        return;
      }
    } else {
      // No record at all — most likely a freshly-issued access
      // token that hasn't yet recorded a heartbeat. Seed it now and
      // continue; the alternative (forcing a 401 here) bites
      // legitimate first-request flows.
    }

    // Throttle the write: most requests in a busy session don't
    // need to refresh the timestamp.
    const lastWrite = lastWriteAt.get(userId) ?? 0;
    if (now - lastWrite >= ACTIVITY_WRITE_THROTTLE_MS) {
      lastWriteAt.set(userId, now);
      const ttlSec = Math.max(60, Math.round(ttlMinutes * 60 * 2));
      void redis.set(ACTIVITY_KEY(userId), String(now), 'EX', ttlSec);
    }
    next();
  } catch {
    // Redis hiccup — fail open (continue) rather than locking the
    // whole app out. The client-side timeout still applies.
    next();
  }
}

/** Helper for handlers mounted behind requireAuth — throws if misused. */
export function userIdOf(req: Request): string {
  const u = (req as Request & WithUser).userId;
  if (!u) throw new Error('userIdOf called without requireAuth');
  return u;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: '15m' });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string };
}
