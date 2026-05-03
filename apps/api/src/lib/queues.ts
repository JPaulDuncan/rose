import { Queue, QueueEvents } from 'bullmq';
import { redis } from './redis.js';

export const QUEUE_NAMES = {
  parseEmail: 'rose.parse-email',
  generatePage: 'rose.generate-page',
  embedPage: 'rose.embed-page',
  imapSync: 'rose.imap-sync',
  gmailSync: 'rose.gmail-sync',
  rssSync: 'rose.rss-sync',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const connection = { connection: redis };

export const parseEmailQueue = new Queue(QUEUE_NAMES.parseEmail, connection);
export const generatePageQueue = new Queue(QUEUE_NAMES.generatePage, connection);
export const embedPageQueue = new Queue(QUEUE_NAMES.embedPage, connection);
export const imapSyncQueue = new Queue(QUEUE_NAMES.imapSync, connection);
export const gmailSyncQueue = new Queue(QUEUE_NAMES.gmailSync, connection);
export const rssSyncQueue = new Queue(QUEUE_NAMES.rssSync, connection);

export const generatePageEvents = new QueueEvents(QUEUE_NAMES.generatePage, connection);
