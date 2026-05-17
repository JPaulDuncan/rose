/**
 * In-process sweeper catalog. Every entry here is a `setInterval`-
 * driven background loop that runs inside the worker process, NOT a
 * BullMQ repeatable. BullMQ schedulers can be enumerated at runtime
 * (`queue.getRepeatableJobs(...)`); these can't — they live in
 * worker memory and aren't visible from the API process.
 *
 * The catalog is the static source of truth: name, interval, what
 * the sweeper does, which worker process owns it. If a sweeper's
 * interval changes in code, update the row in the same commit;
 * `sweeperCatalog.test.ts` fails loud on drift.
 *
 * The admin "Cron jobs" view co-lists these entries alongside the
 * runtime BullMQ repeatables so the operator has one place to see
 * everything Rose runs on a schedule.
 */

export type InProcessSweeper = {
  /** Stable identifier — matches the worker's `start<Sweeper>` entry
   *  point in apps/worker/src/services/* or processors/*. */
  id: string;
  label: string;
  /** One sentence on what the sweeper does. */
  description: string;
  /** Interval in milliseconds. Sourced from the constant at the
   *  declared `definedAt` location. */
  intervalMs: number;
  /** Which worker pool the sweeper boots in (matches the
   *  WORKER_KIND env switch the entrypoint scripts use). */
  pool: 'bg' | 'io' | 'llm' | 'all';
  /** File:line of the SWEEP_INTERVAL_MS constant in the worker — the
   *  thing reviewers should look at when bumping the cadence. */
  definedAt: string;
};

export const SWEEPER_CATALOG: readonly InProcessSweeper[] = [
  {
    id: 'daydream',
    label: 'Daydream sweeper',
    description:
      'Polls pipeline-idle state. When the generate + embed queues are both empty and a user has daydream enabled, picks one unresearched page and enqueues a daydream job.',
    intervalMs: 60_000,
    pool: 'bg',
    definedAt: 'apps/worker/src/services/daydreamSweeper.ts',
  },
  {
    id: 'reputation-decay',
    label: 'Reputation-decay sweep',
    description:
      'Recomputes effective spam-mark counts for senders with auto-quarantine flags using a 30-day half-life. Lifts quarantine when the decayed count falls below threshold.',
    intervalMs: 6 * 60 * 60_000,
    pool: 'bg',
    definedAt: 'apps/worker/src/services/reputationSweep.ts',
  },
  {
    id: 'alert',
    label: 'Alert sweeper',
    description:
      'Evaluates AlertRules against current queue depths + Mongo slow-query stats. Fires push notifications when a threshold crosses; cooldown prevents oscillation spam.',
    intervalMs: 60_000,
    pool: 'bg',
    definedAt: 'apps/worker/src/services/alertSweeper.ts',
  },
  {
    id: 'tag-digest',
    label: 'Tag-digest sweeper',
    description:
      "Walks users with featured tags and enqueues one digest job per (user, tag, UTC-day). Hourly poll is cheap; duplicate enqueues collapse on the same dayKey.",
    intervalMs: 60 * 60_000,
    pool: 'llm',
    definedAt: 'apps/worker/src/processors/tagDigest.ts',
  },
  {
    id: 'library-sync',
    label: 'Library sweeper',
    description:
      "Aggregates due LibrarySources and enqueues sync jobs. A source is due when (lastSyncAt + pollIntervalMinutes) is in the past, or it's never synced.",
    intervalMs: 5 * 60_000,
    pool: 'io',
    definedAt: 'apps/worker/src/processors/librarySync.ts',
  },
  {
    id: 'event-soon',
    label: 'Event-soon push sweep',
    description:
      'Finds enabled `event-soon` push rules and queries CalendarEvents in the configured hours-ahead window. Enqueues a push per matched event.',
    intervalMs: 15 * 60_000,
    pool: 'bg',
    definedAt: 'apps/worker/src/processors/pushNotify.ts',
  },
  {
    id: 'memory-grouping',
    label: 'xMemory grouping sweeper',
    description:
      "Walks users with ungrouped MemoryComponents and runs the xMemory attach / split / merge maintenance — embeds pending components, attaches each to its nearest group above threshold (or seeds a new group), splits oversized / incoherent groups via 2-means, merges near-duplicate centroids, refreshes the kNN neighbour links Stage I retrieval walks.",
    intervalMs: 5 * 60_000,
    pool: 'bg',
    definedAt: 'apps/worker/src/services/memoryGroupingSweep.ts',
  },
  {
    id: 'desk-proposals',
    label: 'Desk-proposal sweeper',
    description:
      'Hourly tick that picks users with ≥ 10 new uncategorized/ad-hoc pages since their last sweep and fewer than 5 pending proposals, then runs the desk-proposer (cluster + name) on their corpus. Persisted lastProposalSweepAt on User settings prevents back-to-back re-entry. Opt-out via settings.desks.autoSuggest.enabled = false.',
    intervalMs: 60 * 60_000,
    pool: 'llm',
    definedAt: 'apps/worker/src/services/deskProposalSweeper.ts',
  },
];

export function getSweeperById(id: string): InProcessSweeper | undefined {
  return SWEEPER_CATALOG.find((s) => s.id === id);
}
