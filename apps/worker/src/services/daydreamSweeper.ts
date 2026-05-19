import { Queue, type JobsOptions } from 'bullmq';
import { Types } from 'mongoose';
import { User, Page } from '@rose/db';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { loadUserAffinityProfile, rankByAffinity } from '../lib/userAffinity.js';

const SWEEP_INTERVAL_MS = 60_000;
/** Per-user pages to enqueue per sweep. Conservative — daydream has
 *  concurrency=1 in the worker so flooding the queue burns the user's
 *  daily cap on the same handful of subjects across many tries. */
const PAGES_PER_SWEEP = 1;

const generatePageQueue = new Queue('rose.generate-page', { connection: redis });
const embedPageQueue = new Queue('rose.embed-page', { connection: redis });
const daydreamQueue = new Queue('rose.daydream', { connection: redis });

/**
 * Returns true when the pipeline is genuinely idle for daydream's
 * purposes — generate-page and embed-page have no waiting/active
 * jobs. We deliberately don't gate on the daydream queue itself
 * (the worker concurrency=1 already serializes) or the sync
 * queues (those are I/O-bound, not LLM-bound).
 */
async function pipelineIdle(): Promise<boolean> {
  const [gen, embed] = await Promise.all([
    generatePageQueue.getJobCounts('waiting', 'active', 'delayed'),
    embedPageQueue.getJobCounts('waiting', 'active'),
  ]);
  const busy =
    (gen.waiting ?? 0) +
    (gen.active ?? 0) +
    (gen.delayed ?? 0) +
    (embed.waiting ?? 0) +
    (embed.active ?? 0);
  return busy === 0;
}

/**
 * Pick the next batch of (userId, pageId) pairs to daydream about.
 * Prioritises pages that:
 *   - belong to a user with daydream enabled
 *   - haven't been daydreamed yet (empty daydreamSubjects), or were
 *     researched a long time ago
 *   - have at least one topic or tag worth researching
 */
async function pickCandidates(): Promise<{ userId: Types.ObjectId; pageId: Types.ObjectId }[]> {
  // Get the set of users who have daydream on. Cheap — usually a
  // handful of rows.
  const enabledUsers = await User.find({
    'settings.daydream.enabled': true,
    'settings.daydream.schedule': { $in: ['idle', 'daily'] },
  })
    .select('_id')
    .lean();
  if (enabledUsers.length === 0) return [];

  const out: { userId: Types.ObjectId; pageId: Types.ObjectId }[] = [];
  for (const u of enabledUsers) {
    // xMemory-aware ordering: pull the top 20 recent un-daydreamed
    // pages, score each by user-affinity (xMemory), pick the
    // highest-scoring one. Pages that match what Rose has learned
    // the user cares about get researched before generic-recency
    // ones. Cold-start users (no MemoryGroups) → affinity = 0 for
    // all candidates → order falls back to recency, matching the
    // pre-personalisation behaviour exactly.
    const candidates = (await Page.find({
      userId: u._id,
      $or: [
        { daydreamSubjects: { $size: 0 } },
        { daydreamSubjects: { $exists: false } },
      ],
      $and: [
        {
          $or: [
            { topics: { $exists: true, $not: { $size: 0 } } },
            { tags: { $exists: true, $not: { $size: 0 } } },
          ],
        },
        // Skip spam-ish pages — daydreaming about marketing junk is a
        // waste of LLM calls.
        {
          $or: [
            { 'flags.userMarkedSpam': { $ne: true } },
            { 'flags.userMarkedSpam': null },
          ],
        },
        {
          $or: [
            { 'flags.hasLikelySpam': { $ne: true } },
            { 'flags.hasLikelySpam': null },
          ],
        },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select('+topicCentroid _id')
      .lean()) as Array<{ _id: Types.ObjectId; topicCentroid?: number[] | null }>;
    if (candidates.length === 0) continue;
    const profile = await loadUserAffinityProfile(u._id);
    const ranked = rankByAffinity(candidates, profile);
    const winner = ranked[0]?.item;
    if (winner) {
      for (let i = 0; i < PAGES_PER_SWEEP; i += 1) {
        out.push({ userId: u._id, pageId: winner._id });
      }
    }
  }
  return out;
}

const jobOpts: JobsOptions = {
  attempts: 1,
  removeOnComplete: 200,
  removeOnFail: 200,
  priority: 10, // low — generate-page jobs queue with default 0 (highest)
};

/**
 * Spin up the sweeper. Polls every minute; when the pipeline is idle
 * and the user has opt-in, enqueues one daydream job. Survives a
 * Redis blip — failures are logged and the sweep retries on the next
 * tick. Stops cleanly on SIGINT/SIGTERM (the parent shutdown handler
 * clears all setTimeouts via .unref()).
 */
export function startDaydreamSweeper(): void {
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!(await pipelineIdle())) return;
      const candidates = await pickCandidates();
      for (const c of candidates) {
        await daydreamQueue.add(
          'page',
          { kind: 'page', userId: String(c.userId), pageId: String(c.pageId) },
          jobOpts,
        );
      }
      if (candidates.length > 0) {
        logger.debug({ enqueued: candidates.length }, 'daydream-sweeper: tick');
      }
    } catch (err) {
      logger.warn({ err }, 'daydream-sweeper: tick failed');
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  handle.unref();
  // Kick once at startup so the user doesn't wait a minute for the
  // first sweep after enabling.
  setTimeout(() => void tick(), 5000).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'daydream-sweeper: started');
}
