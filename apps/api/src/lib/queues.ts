import { Queue, QueueEvents } from 'bullmq';
import { redis } from './redis.js';

export const QUEUE_NAMES = {
  parseEmail: 'rose.parse-email',
  generatePage: 'rose.generate-page',
  embedPage: 'rose.embed-page',
  imapSync: 'rose.imap-sync',
  gmailSync: 'rose.gmail-sync',
  rssSync: 'rose.rss-sync',
  websiteSync: 'rose.website-sync',
  summarizeSender: 'rose.summarize-sender',
  fetchAndParse: 'rose.fetch-and-parse',
  sendOutbound: 'rose.send-outbound',
  digestEmail: 'rose.digest-email',
  webhookDeliver: 'rose.webhook-deliver',
  briefing: 'rose.briefing',
  slackSync: 'rose.slack-sync',
  discordSync: 'rose.discord-sync',
  gcalSync: 'rose.gcal-sync',
  daydream: 'rose.daydream',
  librarySync: 'rose.library-sync',
  libraryEmbed: 'rose.library-embed',
  tagDigest: 'rose.tag-digest',
  /**
   * Plan 12 follow-up — generic post-write hooks for pages written
   * outside the standard `generatePage` flow (synthesis, future
   * imports). Today the only handler is "extract entities + push to
   * daydream subjects", which the worker pulls off the queue and
   * runs through the same `runPostWriteEntityExtraction` helper as
   * inline post-persist.
   */
  postWriteHooks: 'rose.post-write-hooks',
  /**
   * IFTTT-style recipe dispatcher. Every state change that might
   * fire a user recipe enqueues a typed event here; the recipes
   * worker fans out to matching recipes. See .devlogs/IFTTT-feature.md.
   */
  recipes: 'rose.recipes',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const connection = { connection: redis };

export const parseEmailQueue = new Queue(QUEUE_NAMES.parseEmail, connection);
export const generatePageQueue = new Queue(QUEUE_NAMES.generatePage, connection);
export const embedPageQueue = new Queue(QUEUE_NAMES.embedPage, connection);
export const imapSyncQueue = new Queue(QUEUE_NAMES.imapSync, connection);
export const gmailSyncQueue = new Queue(QUEUE_NAMES.gmailSync, connection);
export const rssSyncQueue = new Queue(QUEUE_NAMES.rssSync, connection);
export const websiteSyncQueue = new Queue(QUEUE_NAMES.websiteSync, connection);
export const summarizeSenderQueue = new Queue(QUEUE_NAMES.summarizeSender, connection);
export const fetchAndParseQueue = new Queue(QUEUE_NAMES.fetchAndParse, connection);
export const sendOutboundQueue = new Queue(QUEUE_NAMES.sendOutbound, connection);
export const digestEmailQueue = new Queue(QUEUE_NAMES.digestEmail, connection);
export const webhookDeliverQueue = new Queue(QUEUE_NAMES.webhookDeliver, connection);
export const briefingQueue = new Queue(QUEUE_NAMES.briefing, connection);
export const slackSyncQueue = new Queue(QUEUE_NAMES.slackSync, connection);
export const discordSyncQueue = new Queue(QUEUE_NAMES.discordSync, connection);
export const gcalSyncQueue = new Queue(QUEUE_NAMES.gcalSync, connection);
export const daydreamQueue = new Queue(QUEUE_NAMES.daydream, connection);
export const librarySyncQueue = new Queue(QUEUE_NAMES.librarySync, connection);
export const libraryEmbedQueue = new Queue(QUEUE_NAMES.libraryEmbed, connection);
export const tagDigestQueue = new Queue(QUEUE_NAMES.tagDigest, connection);
export const postWriteHooksQueue = new Queue(QUEUE_NAMES.postWriteHooks, connection);
export const recipesQueue = new Queue(QUEUE_NAMES.recipes, connection);

export const generatePageEvents = new QueueEvents(QUEUE_NAMES.generatePage, connection);
