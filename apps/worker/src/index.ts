import { connectMongo } from './lib/db.js';
import { logger } from './lib/logger.js';
import { startGeneratePageWorker } from './processors/generatePage.js';
import { startEmbedPageWorker } from './processors/embedPage.js';
import { startImapSyncWorker } from './processors/imapSync.js';
import { startGmailSyncWorker } from './processors/gmailSync.js';

async function bootstrap() {
  await connectMongo();
  startGeneratePageWorker();
  startEmbedPageWorker();
  startImapSyncWorker();
  startGmailSyncWorker();
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
