import { Queue } from 'bullmq';
import { connectMongo } from './lib/db.js';
import { redis, bullConnection } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { startGeneratePageWorker } from './processors/generatePage.js';
import { startEmbedPageWorker } from './processors/embedPage.js';
import { startImapSyncWorker } from './processors/imapSync.js';
import { startGmailSyncWorker } from './processors/gmailSync.js';
import { startRssSyncWorker } from './processors/rssSync.js';
import { startWebsiteSyncWorker } from './processors/websiteSync.js';
import { startSlackSyncWorker } from './processors/slackSync.js';
import { startDiscordSyncWorker } from './processors/discordSync.js';
import { startGcalSyncWorker } from './processors/gcalSync.js';
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
import { startRecipesWorker } from './processors/recipes.js';
import { startCleanupWorker, scheduleCleanupSweeper } from './processors/cleanup.js';
import {
  startWeatherSnapshotWorker,
  scheduleWeatherSnapshotSweeper,
} from './processors/weatherSnapshots.js';
import { startReputationDecaySweep } from './services/reputationSweep.js';
import { startDaydreamSweeper } from './services/daydreamSweeper.js';
import { reconcileSourceSchedules } from './services/sourceScheduleReconciler.js';
import { getVapidKeys } from './lib/vapid.js';

async function bootstrap() {
  await connectMongo();
  startGeneratePageWorker();
  startEmbedPageWorker();
  startImapSyncWorker();
  startGmailSyncWorker();
  startRssSyncWorker();
  startWebsiteSyncWorker();
  startSlackSyncWorker();
  startDiscordSyncWorker();
  startGcalSyncWorker();
  startSummarizeSenderWorker();
  startFetchAndParseWorker();
  startSendOutboundWorker();
  startDigestEmailWorker();
  startWebhookDeliverWorker();
  startPushNotifyWorker();
  startEventSoonSweep();
  startBriefingWorker();
  startDaydreamWorker();
  startDaydreamSweeper();
  startLibrarySyncWorker();
  startLibraryEmbedWorker();
  startLibrarySweeper();
  startTagDigestWorker();
  startTagDigestSweeper();
  startPostWriteHooksWorker();
  startRecipesWorker();
  // Initialise VAPID keys at boot (generates on first run, persists
  // to var/vapid.json so the API can read the public half).
  getVapidKeys();
  startReputationDecaySweep();
  // Repeatable hourly sweep that fires the digest mailer for every
  // user whose configured local time matches the current hour.
  const digestQueue = new Queue('rose.digest-email', { connection: bullConnection() });
  await digestQueue.add(
    'sweep',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'digest:sweep' },
  );
  // Kick off an immediate one-shot so the user doesn't wait an hour
  // after first enabling.
  await digestQueue.add('sweep', {}, { attempts: 1, removeOnComplete: 10 });
  // Same hourly sweep pattern for the LLM-narrative briefing.
  const briefingQueue = new Queue('rose.briefing', { connection: bullConnection() });
  await briefingQueue.add(
    'sweep',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'briefing:sweep' },
  );
  await briefingQueue.add('sweep', {}, { attempts: 1, removeOnComplete: 10 });
  // Daily retention sweep — prunes emails / revisions / daydream
  // notes / etc. older than the per-user retention windows.
  startCleanupWorker();
  await scheduleCleanupSweeper();
  // Server-side weather-snapshot poll so the trend chart on /weather
  // hydrates even when no user is actively browsing the home panel.
  startWeatherSnapshotWorker();
  await scheduleWeatherSnapshotSweeper();
  // Reconcile per-source repeatables in case Redis lost its
  // schedule data (volume wipe, persistence gap, etc.). Without
  // this, a missing repeatable means the source silently stops
  // polling forever — the only recovery today is editing the
  // interval in the UI.
  void reconcileSourceSchedules()
    .then((r) =>
      logger.info(r, 'source-schedule reconcile complete'),
    )
    .catch((err) =>
      logger.warn({ err }, 'source-schedule reconcile failed'),
    );
  logger.info('rose worker started');
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
