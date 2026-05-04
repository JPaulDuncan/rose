import express, { type Express } from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { OllamaClient } from '@rose/llm';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { connectMongo } from './lib/db.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { emailsRouter } from './routes/emails.js';
import { pagesRouter } from './routes/pages.js';
import { searchRouter } from './routes/search.js';
import { instructionsRouter } from './routes/instructions.js';
import { sourcesRouter } from './routes/sources.js';
import { categoriesRouter } from './routes/categories.js';
import { jobsRouter, jobsStreamRouter } from './routes/jobs.js';
import { digestRouter } from './routes/digest.js';
import { eventsRouter } from './routes/events.js';
import { streamsRouter } from './routes/streams.js';
import { tagsRouter } from './routes/tags.js';
import { spamRouter } from './routes/spam.js';
import { featuredTagsRouter } from './routes/featuredTags.js';
import { weatherRouter } from './routes/weather.js';
import { webhookRouter } from './routes/webhook.js';
import { providersRouter } from './routes/providers.js';
import { modelsRouter, modelsStreamRouter } from './routes/models.js';
import { sendersRouter } from './routes/senders.js';
import { codexRouter } from './routes/codex.js';
import { quarantineRouter } from './routes/quarantine.js';
import { promotionsRouter } from './routes/promotions.js';
import { chatRouter } from './routes/chat.js';
import { saveRouter } from './routes/save.js';
import { replyRouter, outboundRouter } from './routes/reply.js';
import { rulesRouter } from './routes/rules.js';
import { shareRouter, sharePublicRouter } from './routes/share.js';
import { webhooksRouter } from './routes/webhooks.js';
import { errorHandler } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { redis } from './lib/redis.js';
import { generatePageEvents } from './lib/queues.js';
import { jobEvents } from './services/sse.js';

export async function createServer(): Promise<Express> {
  await connectMongo();

  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(pinoHttp({ logger }));

  // Webhook expects raw body, register before json parser.
  app.use(
    '/api/webhook',
    express.raw({ type: ['message/rfc822', 'text/plain', 'application/octet-stream'], limit: '25mb' }),
    webhookRouter,
  );

  app.use(express.json({ limit: '5mb' }));
  app.use(apiLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/ready', async (_req, res) => {
    const ollama = new OllamaClient({ baseUrl: env.OLLAMA_URL });
    const [redisOk, ollamaOk] = await Promise.all([
      redis.ping().then((r: string) => r === 'PONG').catch(() => false),
      ollama.ping(),
    ]);
    const mongoOk = mongoose.connection.readyState === 1;
    const ok = mongoOk && redisOk && ollamaOk;
    res.status(ok ? 200 : 503).json({ ok, mongo: mongoOk, redis: redisOk, ollama: ollamaOk });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/me', requireAuth, meRouter);
  app.use('/api/emails', requireAuth, emailsRouter);
  app.use('/api/pages', requireAuth, pagesRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api/instructions', requireAuth, instructionsRouter);
  app.use('/api/sources', requireAuth, sourcesRouter);
  app.use('/api/categories', requireAuth, categoriesRouter);
  // SSE stream auth via query param; mount before requireAuth-protected jobs.
  app.use('/api/jobs', jobsStreamRouter);
  app.use('/api/jobs', requireAuth, jobsRouter);
  app.use('/api/digest', requireAuth, digestRouter);
  app.use('/api/events', requireAuth, eventsRouter);
  app.use('/api/streams', requireAuth, streamsRouter);
  app.use('/api/tags', requireAuth, tagsRouter);
  app.use('/api/spam', requireAuth, spamRouter);
  app.use('/api/featured-tags', requireAuth, featuredTagsRouter);
  app.use('/api/weather', requireAuth, weatherRouter);
  app.use('/api/providers', requireAuth, providersRouter);
  // Streaming pull auth via query param; mount before the protected models router.
  app.use('/api/models', modelsStreamRouter);
  app.use('/api/models', requireAuth, modelsRouter);
  app.use('/api/senders', requireAuth, sendersRouter);
  app.use('/api/codex', requireAuth, codexRouter);
  app.use('/api/quarantine', requireAuth, quarantineRouter);
  app.use('/api/promotions', requireAuth, promotionsRouter);
  app.use('/api/chat', requireAuth, chatRouter);
  app.use('/api/save', requireAuth, saveRouter);
  app.use('/api/emails', requireAuth, replyRouter);
  app.use('/api/outbound', requireAuth, outboundRouter);
  app.use('/api/rules', requireAuth, rulesRouter);
  app.use('/api/share', requireAuth, shareRouter);
  app.use('/api/webhooks', requireAuth, webhooksRouter);
  // Public read-only render — NO auth, mounted outside /api so
  // anonymous viewers can hit it without a Bearer token.
  app.use('/share', sharePublicRouter);

  app.use(errorHandler);

  return app;
}

async function bootstrap() {
  const app = await createServer();

  // Reconcile system instruction templates for existing users on every boot,
  // so seed-prompt improvements propagate without manual migration.
  try {
    const { User } = await import('@rose/db');
    const { seedSystemInstructionsForUser } = await import('./services/instructions.js');
    const users = await User.find({}).select('_id').lean();
    for (const u of users) {
      await seedSystemInstructionsForUser(u._id);
    }
    if (users.length) logger.info({ users: users.length }, 'reconciled seed instructions');
  } catch (err) {
    logger.warn({ err }, 'seed reconcile failed');
  }

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'rose api listening');
  });

  // Forward worker progress events into the SSE bus.
  generatePageEvents.on('progress', ({ jobId, data }) => {
    if (data && typeof data === 'object') {
      jobEvents.publish(String(jobId), data as Parameters<typeof jobEvents.publish>[1]);
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
