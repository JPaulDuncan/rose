import { Queue } from 'bullmq';
import mongoose from 'mongoose';
import { syncAllIndexes, runMigrations } from '@rose/db';
import { connectMongo } from './lib/db.js';
import { redis, bullConnection } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { startMetricsPublisher } from './lib/metrics.js';
import { startGeneratePageWorker } from './processors/generatePage.js';
import { startEmbedPageWorker } from './processors/embedPage.js';
import { startImapSyncWorker } from './processors/imapSync.js';
import { startGmailSyncWorker } from './processors/gmailSync.js';
import { startRssSyncWorker } from './processors/rssSync.js';
import { startWebsiteSyncWorker } from './processors/websiteSync.js';
import { startSlackSyncWorker } from './processors/slackSync.js';
import { startDiscordSyncWorker } from './processors/discordSync.js';
import { startGcalSyncWorker } from './processors/gcalSync.js';
import { startIcsSyncWorker } from './processors/icsSync.js';
import { startSummarizeSenderWorker } from './processors/summarizeSender.js';
import { startFetchAndParseWorker } from './processors/fetchAndParse.js';
import { startSendOutboundWorker } from './processors/sendOutbound.js';
import { startDigestEmailWorker } from './processors/digestEmail.js';
import { startWebhookDeliverWorker } from './processors/webhookDeliver.js';
import {
  startPushNotifyWorker,
  startEventSoonSweep,
} from './processors/pushNotify.js';
import { startBriefingWorker } from './processors/briefing.js';
import { startDaydreamWorker } from './processors/daydream.js';
import {
  startLibrarySyncWorker,
  startLibrarySweeper,
} from './processors/librarySync.js';
import { startLibraryEmbedWorker } from './processors/libraryEmbed.js';
import { startTagDigestWorker, startTagDigestSweeper } from './processors/tagDigest.js';
import { startPostWriteHooksWorker } from './processors/postWriteHooks.js';
import { startBackfillWorker } from './processors/backfill.js';
import { startRecipesWorker } from './processors/recipes.js';
import { startCleanupWorker, scheduleCleanupSweeper } from './processors/cleanup.js';
import { startTopicResearchWorker } from './processors/topicResearch.js';
import {
  startWeatherSnapshotWorker,
  scheduleWeatherSnapshotSweeper,
} from './processors/weatherSnapshots.js';
import { startReputationDecaySweep } from './services/reputationSweep.js';
import { startAlertSweeper } from './services/alertSweeper.js';
import { startDaydreamSweeper } from './services/daydreamSweeper.js';
import { reconcileSourceSchedules } from './services/sourceScheduleReconciler.js';
import { getVapidKeys } from './lib/vapid.js';

/**
 * Worker process topology — perf-roadmap Phase B.
 *
 * The single-process `all` mode boots every worker in one Node
 * process; that's the original shape and remains the default for
 * solo self-hosted deploys where the operator wants one container
 * to manage. The four split modes (`llm`, `io`, `cpu`, `bg`)
 * register only a subset of workers per process so multi-container
 * deploys can scale CPU-bound work independently from LLM-bound work
 * and from background sweeps. Pick a mode by setting `WORKER_MODE`
 * in the environment; same Docker image, four service entries in
 * compose.
 *
 * Routing rules:
 *   • `llm`   — every worker that issues Ollama generations or
 *               long synthesis prompts. Concurrency is bounded by
 *               Ollama's NUM_PARALLEL; small replica count.
 *   • `io`    — sync workers that mostly wait on the network
 *               (IMAP / Gmail / RSS / website / Slack / Discord /
 *               Gcal / library / fetchAndParse). High concurrency
 *               within the process; scale replicas for throughput.
 *   • `cpu`   — embed + post-write hooks + library embed. CPU-bound
 *               work that benefits from matching `os.cpus().length`.
 *   • `bg`    — push, outbound, webhooks, weather snapshots, cleanup,
 *               recipes, briefing/digest sweepers. Light, opinionated
 *               cadence work; one replica is plenty.
 *
 * Sweepers, repeatable schedulers, and one-shot bootstrap tasks run
 * on the process whose mode owns the corresponding worker — there's
 * no point scheduling weather snapshots if the snapshot worker isn't
 * registered. The `all` mode runs everything (current behaviour).
 *
 * Operationally the cleanest split (compose `replicas:` count in
 * parentheses) is:
 *   - worker-llm  (1)  WORKER_MODE=llm
 *   - worker-io   (2)  WORKER_MODE=io
 *   - worker-cpu  (1)  WORKER_MODE=cpu
 *   - worker-bg   (1)  WORKER_MODE=bg
 * but the actual replica counts are the operator's call.
 */
type WorkerMode = 'all' | 'llm' | 'io' | 'cpu' | 'bg';

function parseWorkerMode(): WorkerMode {
  const raw = (process.env.WORKER_MODE ?? 'all').toLowerCase();
  if (raw === 'all' || raw === 'llm' || raw === 'io' || raw === 'cpu' || raw === 'bg') {
    return raw as WorkerMode;
  }
  logger.warn({ raw }, `unknown WORKER_MODE; falling back to 'all'`);
  return 'all';
}

const MODE: WorkerMode = parseWorkerMode();
const has = (kind: WorkerMode | WorkerMode[]): boolean => {
  if (MODE === 'all') return true;
  return Array.isArray(kind) ? kind.includes(MODE) : kind === MODE;
};

/**
 * Index sync + one-shot migrations live with one mode in split
 * deploys, otherwise four worker processes race to call
 * `syncIndexes` simultaneously. MongoDB serialises createIndex
 * internally so the result is correct, but the noise is needless;
 * the `bg` worker is the natural single-instance migration owner
 * (light cadence, slow boot is fine, no traffic depends on it).
 * The single-process `all` mode runs them too.
 *
 * Index creation runs in the background by default on MongoDB 4.2+,
 * so this does not block reads or writes against existing data even
 * when adding indexes to large collections.
 */
/**
 * Enable MongoDB's slow-query profiler at boot. Level 1 + slowms=100
 * captures every operation that takes longer than 100ms in the
 * `system.profile` capped collection — the diagnostics surface
 * reads from there to render a slow-query panel without us having
 * to instrument every Mongoose call site.
 *
 * Idempotent: profile level + slowms get set on every boot, so an
 * operator can flip it off via a one-shot `db.setProfilingLevel(0)`
 * and the worker will turn it back on next restart. Failures here
 * are non-fatal — Mongo deployments without profiler privileges
 * (Atlas tier restrictions, etc.) just continue without the data.
 *
 * Routed through bg-mode in split deploys for the same reason
 * applySchemaMigrations is — one process owns the side-effectful
 * boot work, so concurrent workers don't all reach for the same
 * admin command.
 */
async function enableMongoProfiler() {
  if (!has('bg')) return;
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    await db.command({ profile: 1, slowms: 100, sampleRate: 1.0 });
    logger.info({ slowms: 100 }, 'mongo: slow-query profiler enabled');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'mongo: slow-query profiler enable failed (continuing)',
    );
  }
}

async function applySchemaMigrations() {
  if (!has('bg')) return;
  try {
    const t0 = Date.now();
    const indexResult = await syncAllIndexes();
    const indexMs = Date.now() - t0;
    logger.info(
      {
        models: indexResult.models.length,
        created: indexResult.created,
        dropped: indexResult.dropped,
        failed: indexResult.failed,
        elapsedMs: indexMs,
      },
      'schema indexes synced',
    );
    if (indexResult.failed.length > 0) {
      // Emit failures at warn but don't block startup — a single
      // misconfigured index shouldn't keep the whole worker down.
      for (const f of indexResult.failed) {
        logger.warn({ model: f.model, error: f.error }, 'index sync failed for model');
      }
    }
  } catch (err) {
    logger.error({ err }, 'index sync failed (continuing)');
  }
  try {
    const t0 = Date.now();
    const migResult = await runMigrations();
    if (migResult.applied.length > 0 || migResult.skipped.length > 0) {
      logger.info(
        { applied: migResult.applied, skipped: migResult.skipped.length, elapsedMs: Date.now() - t0 },
        'data migrations complete',
      );
    }
  } catch (err) {
    // Data migrations failing IS something to flag — they may have
    // left the DB in a half-applied state. Surface loudly but don't
    // hard-exit; an operator should investigate.
    logger.error({ err }, 'data migrations failed; investigate before next deploy');
  }
}

async function bootstrap() {
  await connectMongo();
  logger.info({ mode: MODE }, 'worker bootstrap');

  // Every worker process publishes a metrics snapshot to Redis
  // every 30s; the API's diagnostics endpoint aggregates across
  // the live set. Started before workers register so the very
  // first job's timings get captured.
  startMetricsPublisher();

  // Run before any worker registers so the indexes are in place
  // before the first BullMQ job hits the DB.
  await applySchemaMigrations();
  await enableMongoProfiler();

  // -----------------------------------------------------------------
  // LLM-bound workers — generation, narrative synthesis, summarisation.
  // -----------------------------------------------------------------
  if (has('llm')) {
    startGeneratePageWorker();
    startSummarizeSenderWorker();
    startBriefingWorker();
    startDaydreamWorker();
    startTagDigestWorker();
    startDigestEmailWorker();
    startRecipesWorker();
    // Topic research is LLM-bound at the synthesis step (the long
    // pole of any run); the fetch loop within the same job runs
    // serially with the LLM call so concurrency caps with llm.
    startTopicResearchWorker();
  }

  // -----------------------------------------------------------------
  // I/O-bound workers — network sync, fetch, polling.
  // -----------------------------------------------------------------
  if (has('io')) {
    startImapSyncWorker();
    startGmailSyncWorker();
    startRssSyncWorker();
    startWebsiteSyncWorker();
    startSlackSyncWorker();
    startDiscordSyncWorker();
    startGcalSyncWorker();
    startIcsSyncWorker();
    startFetchAndParseWorker();
    startLibrarySyncWorker();
  }

  // -----------------------------------------------------------------
  // CPU-bound workers — embedding, post-write hooks (entity / place
  // extraction), library embedding. These are the workers that
  // benefit most from `os.cpus().length`-scale concurrency.
  // -----------------------------------------------------------------
  if (has('cpu')) {
    startEmbedPageWorker();
    startLibraryEmbedWorker();
    startPostWriteHooksWorker();
    // Backfill runs alongside post-write hooks — same workload
    // shape (an extractor pass per page) so it makes sense on the
    // same process. Low concurrency, low priority.
    startBackfillWorker();
  }

  // -----------------------------------------------------------------
  // Background workers — push, outbound, webhooks, weather, cleanup.
  // Light cadence; one replica is enough.
  // -----------------------------------------------------------------
  if (has('bg')) {
    startSendOutboundWorker();
    startWebhookDeliverWorker();
    startPushNotifyWorker();
    startEventSoonSweep();
    startCleanupWorker();
    startWeatherSnapshotWorker();
  }

  // -----------------------------------------------------------------
  // VAPID + reputation decay run alongside push, so they go on
  // worker-bg in split mode.
  // -----------------------------------------------------------------
  if (has('bg')) {
    // Initialise VAPID keys at boot (generates on first run, persists
    // to var/vapid.json so the API can read the public half).
    getVapidKeys();
    startReputationDecaySweep();
    // Operator alert engine — every 60s, evaluate every enabled
    // AlertRule against current queue counts + slow-query stats
    // and fire push notifications for triggered rules past their
    // cooldown. Lives in bg-mode so we don't multi-fire in split
    // deploys.
    startAlertSweeper();
  }

  // -----------------------------------------------------------------
  // Repeatable schedulers + one-shot kicks. We co-locate each with
  // the worker that handles it: digest sweep → llm, briefing sweep
  // → llm, cleanup → bg, weather → bg, library sweeper → io,
  // tag-digest sweeper → llm, daydream sweeper → llm.
  // -----------------------------------------------------------------
  if (has('llm')) {
    const digestQueue = new Queue('rose.digest-email', { connection: bullConnection() });
    await digestQueue.add(
      'sweep',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'digest:sweep' },
    );
    await digestQueue.add('sweep', {}, { attempts: 1, removeOnComplete: 10 });

    const briefingQueue = new Queue('rose.briefing', { connection: bullConnection() });
    await briefingQueue.add(
      'sweep',
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: 'briefing:sweep' },
    );
    await briefingQueue.add('sweep', {}, { attempts: 1, removeOnComplete: 10 });

    startTagDigestSweeper();
    startDaydreamSweeper();
  }

  if (has('io')) {
    startLibrarySweeper();
  }

  if (has('bg')) {
    await scheduleCleanupSweeper();
    await scheduleWeatherSnapshotSweeper();
  }

  // -----------------------------------------------------------------
  // Source-schedule reconciler. Re-arms missing per-source repeatables
  // (IMAP / Gmail / RSS / website / Slack / Discord / Gcal). The
  // queues for those live with worker-io, so the reconciler runs
  // there. In `all` mode it runs once as before.
  // -----------------------------------------------------------------
  if (has('io')) {
    void reconcileSourceSchedules()
      .then((r) =>
        logger.info(r, 'source-schedule reconcile complete'),
      )
      .catch((err) =>
        logger.warn({ err }, 'source-schedule reconcile failed'),
      );
  }

  logger.info({ mode: MODE }, 'rose worker started');
}

bootstrap().catch((err) => {
  logger.error({ err }, 'fatal worker startup');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker shutting down');
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
