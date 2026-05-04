import { pino, stdSerializers } from 'pino';
import { env } from './env.js';

/**
 * Worker logger. In development we crank the level to `debug` and
 * serialise full error stacks so silent failures (a swallowed
 * try/catch, a BullMQ retry that fails on every attempt) actually
 * surface in the terminal. Operators can override with LOG_LEVEL.
 */
const level =
  process.env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  base: { app: 'rose-worker' },
  // Serialise errors with their full stack — pino's default skips
  // non-enumerable Error.stack, which makes BullMQ retries opaque.
  serializers: {
    err: stdSerializers.err,
    error: stdSerializers.err,
  },
});

// Surface anything that escapes a Promise — newer Node versions
// terminate the process on unhandled rejections by default, but
// pino otherwise prints nothing about why.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
});
