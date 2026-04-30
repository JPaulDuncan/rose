import { pino } from 'pino';

export const logger = pino({ base: { app: 'rose-worker' } });
