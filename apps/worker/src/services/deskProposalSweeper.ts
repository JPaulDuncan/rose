import { Types } from 'mongoose';
import { User, Category, Page } from '@rose/db';
import { proposeDesksForUser } from './proposeDesks.js';
import { logger } from '../lib/logger.js';

/**
 * Periodic desk-proposal sweeper. Ticks hourly, picks users who:
 *
 *   1. Have `settings.desks.autoSuggest.enabled !== false` (default
 *      true — opt-out, not opt-in).
 *   2. Have accumulated ≥ MIN_NEW_PAGES_BEFORE_SWEEP uncategorized
 *      or ad-hoc-categorized pages since their last sweep. The
 *      threshold prevents the sweeper from burning the daily cap
 *      proposing for a quiet inbox.
 *   3. Have fewer than MAX_PENDING_PROPOSALS_GATE pending proposals
 *      already. We don't pile on new suggestions while the user
 *      still has older ones to triage; the rejected-name dedup in
 *      proposeDesksForUser handles the reverse case but a wall of
 *      pending cards in the UI is its own problem.
 *
 * Bookkeeping field: `User.settings.desks.lastProposalSweepAt`.
 * Persisted at sweep START (not END) so a concurrent restart can't
 * double-fire; a failed sweep just waits for the next tick to
 * retry rather than re-entering immediately.
 */

const SWEEP_INTERVAL_MS = 60 * 60_000;
const MIN_NEW_PAGES_BEFORE_SWEEP = 10;
const MAX_PENDING_PROPOSALS_GATE = 5;
/** Per-tick concurrency. Each user's sweep makes up to 6 LLM
 *  calls; keep this low so a deploy of 100 users doesn't dump 600
 *  LLM calls onto the gen provider at once. */
const USERS_PER_TICK = 10;

type DeskSettings = {
  autoSuggest?: { enabled?: boolean };
  lastProposalSweepAt?: Date | string | null;
};

type UserRow = {
  _id: Types.ObjectId;
  settings?: { desks?: DeskSettings } | null;
};

/**
 * Check whether `userId` is currently due for a sweep. Exposed so
 * an admin "trigger sweep now" endpoint can skip the gates with a
 * `force` flag in the future without re-implementing them.
 *
 * Returns:
 *   { due: true }                 — gates pass, run it
 *   { due: false, reason: ... }   — gates failed; reason for logs
 */
export async function isUserDueForDeskSweep(
  userId: Types.ObjectId,
  settings: DeskSettings | undefined,
  activeDeskIds: Types.ObjectId[],
): Promise<{ due: boolean; reason?: string }> {
  // Gate 1: opt-out check.
  if (settings?.autoSuggest?.enabled === false) {
    return { due: false, reason: 'auto-suggest-disabled' };
  }

  // Gate 2: pending-backlog check. If the user already has plenty
  // of suggestions waiting, don't add more.
  const pending = await Category.countDocuments({
    userId,
    kind: 'desk',
    status: 'proposed',
  });
  if (pending >= MAX_PENDING_PROPOSALS_GATE) {
    return { due: false, reason: 'too-many-pending' };
  }

  // Gate 3: new-content check. Skip if the user hasn't accumulated
  // enough off-desk pages since the last sweep.
  const since = settings?.lastProposalSweepAt
    ? new Date(settings.lastProposalSweepAt)
    : null;
  const filter: Record<string, unknown> = {
    userId,
    'flags.userMarkedSpam': { $ne: true },
    $or: [{ categoryId: null }, { categoryId: { $nin: activeDeskIds } }],
  };
  if (since) filter.updatedAt = { $gte: since };
  const newPages = await Page.countDocuments(filter);
  if (newPages < MIN_NEW_PAGES_BEFORE_SWEEP) {
    return { due: false, reason: 'too-few-new-pages' };
  }

  return { due: true };
}

/**
 * Run one tick: enumerate users, gate them, run proposals on the
 * due ones up to USERS_PER_TICK. Exposed (via `runDeskProposalSweepNow`)
 * so the admin "Run now" button can fire a tick on demand.
 */
async function sweepTick(force = false): Promise<{ swept: number; proposed: number }> {
  const out = { swept: 0, proposed: 0 };
  // Pull users that haven't opted out. `settings.desks.autoSuggest.enabled`
  // is undefined by default → opt-out, not opt-in.
  const candidates = (await User.find({
    'settings.desks.autoSuggest.enabled': { $ne: false },
  })
    .select('settings.desks')
    .limit(500)
    .lean()) as UserRow[];

  // Sort by oldest last-sweep first so a backlog doesn't strand the
  // least-recently-swept user behind a recently-active one.
  candidates.sort((a, b) => {
    const at = a.settings?.desks?.lastProposalSweepAt
      ? new Date(a.settings.desks.lastProposalSweepAt).getTime()
      : 0;
    const bt = b.settings?.desks?.lastProposalSweepAt
      ? new Date(b.settings.desks.lastProposalSweepAt).getTime()
      : 0;
    return at - bt;
  });

  for (const u of candidates) {
    if (out.swept >= USERS_PER_TICK) break;
    const userId = u._id;
    // Cache the user's active-desk ids once per user; both the gate
    // check and proposeDesksForUser need them and the query is
    // single-index-served so a second call would be cheap, but
    // sharing avoids the latency stack-up.
    const activeDeskIds = (await Category.find({
      userId,
      kind: 'desk',
      status: 'active',
    })
      .select('_id')
      .lean()).map((c) => c._id as Types.ObjectId);

    // `force=true` bypasses the threshold gates (new-content,
    // pending-backlog) but still honours the per-user opt-out —
    // we never burn LLM calls for a user who said "don't propose
    // for me." Admin-triggered runs use this to kick a sweep even
    // when the new-content threshold hasn't been crossed yet.
    if (!force) {
      const gate = await isUserDueForDeskSweep(
        userId,
        u.settings?.desks,
        activeDeskIds,
      );
      if (!gate.due) {
        logger.debug(
          { userId: String(userId), reason: gate.reason },
          'desk-proposal sweep: gated',
        );
        continue;
      }
    } else if (u.settings?.desks?.autoSuggest?.enabled === false) {
      logger.debug(
        { userId: String(userId) },
        'desk-proposal sweep: opt-out honoured even under force',
      );
      continue;
    }

    // Persist sweep-start timestamp BEFORE running so a restart in
    // the middle of a long LLM run doesn't immediately re-pick this
    // user. We accept that a failed sweep waits an hour; that's
    // strictly better than back-to-back re-entry.
    await User.updateOne(
      { _id: userId },
      { $set: { 'settings.desks.lastProposalSweepAt': new Date() } },
    );

    try {
      const summary = await proposeDesksForUser(userId);
      out.swept += 1;
      out.proposed += summary.proposalsCreated;
      if (summary.proposalsCreated > 0) {
        logger.info(
          {
            userId: String(userId),
            proposed: summary.proposalsCreated,
            considered: summary.clustersConsidered,
          },
          'desk-proposal sweep: proposed new desks',
        );
      }
    } catch (err) {
      logger.warn(
        { err, userId: String(userId) },
        'desk-proposal sweep: per-user run failed (continuing)',
      );
    }
  }
  return out;
}

/**
 * On-demand sweep tick. Identical to the timer-driven path but
 * callable from an admin endpoint. `force=true` skips the new-
 * content and pending-backlog gates so a manual "Run now" actually
 * does something even when those gates would normally hold the
 * tick.
 */
export async function runDeskProposalSweepNow(opts: { force?: boolean } = {}): Promise<{
  swept: number;
  proposed: number;
}> {
  return sweepTick(!!opts.force);
}

export function startDeskProposalSweeper(): { stop: () => void } {
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await sweepTick();
      if (r.swept > 0) {
        logger.info(r, 'desk-proposal sweep: tick done');
      }
    } catch (err) {
      logger.warn({ err }, 'desk-proposal sweep: tick failed');
    } finally {
      busy = false;
    }
  }, SWEEP_INTERVAL_MS);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
}

// Re-export thresholds for tests so production and assertions
// stay in lockstep.
export const _MIN_NEW_PAGES_BEFORE_SWEEP = MIN_NEW_PAGES_BEFORE_SWEEP;
export const _MAX_PENDING_PROPOSALS_GATE = MAX_PENDING_PROPOSALS_GATE;
