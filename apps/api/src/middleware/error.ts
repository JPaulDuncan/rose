import type { ErrorRequestHandler } from 'express';
import { logger } from '../lib/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'request_failed');
  if (res.headersSent) return;
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({
    error: status === 500 ? 'internal_error' : 'request_error',
    message: (err as Error).message ?? 'Unexpected error',
  });
};
