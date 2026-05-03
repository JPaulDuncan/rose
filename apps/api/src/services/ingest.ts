import { Types } from 'mongoose';
import { parseEmail, type CleanedEmail } from '@rose/email-parser';
import { Email } from '@rose/db';
import { parseEmailQueue, generatePageQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export type IngestInput = {
  userId: Types.ObjectId;
  sourceId?: Types.ObjectId | null;
  raw: Buffer;
};

export type IngestResult =
  | { kind: 'created'; emailId: string; jobId: string }
  | { kind: 'duplicate'; emailId: string };

/**
 * Ingest a raw RFC822 email blob: parse, dedupe, persist, enqueue page generation.
 * Returns a duplicate marker when the same (userId, rawHash) already exists.
 */
export async function ingestRawEmail(input: IngestInput): Promise<IngestResult> {
  const cleaned: CleanedEmail = await parseEmail(input.raw);

  const existing = await Email.findOne({ userId: input.userId, rawHash: cleaned.rawHash });
  if (existing) {
    return { kind: 'duplicate', emailId: existing._id.toString() };
  }

  const doc = await Email.create({
    userId: input.userId,
    sourceId: input.sourceId ?? null,
    messageId: cleaned.messageId,
    threadKey: cleaned.threadKey,
    subjectTemplate: cleaned.subjectTemplate,
    rawHash: cleaned.rawHash,
    from: cleaned.from,
    to: cleaned.to,
    cc: cleaned.cc,
    subject: cleaned.subject,
    date: cleaned.date,
    text: cleaned.text,
    rawText: cleaned.rawText,
    html: cleaned.html,
    attachments: cleaned.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      contentId: a.contentId,
    })),
    priority: cleaned.metadata.priority,
    topics: cleaned.metadata.topics,
    links: cleaned.metadata.links,
    images: cleaned.metadata.images,
    spamScore: cleaned.metadata.spamScore,
    spamSignals: cleaned.metadata.spamSignals,
    isMassMailing: cleaned.metadata.isMassMailing,
    logoCandidate: cleaned.metadata.logoCandidate ?? undefined,
    unsubscribeUrls: cleaned.metadata.unsubscribeUrls,
    ingestStatus: 'parsed',
  });

  const job = await generatePageQueue.add(
    'generate',
    { emailId: doc._id.toString(), userId: input.userId.toString() },
    { removeOnComplete: 500, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  );

  logger.info({ emailId: doc._id.toString(), jobId: job.id }, 'email ingested, generation queued');
  return { kind: 'created', emailId: doc._id.toString(), jobId: job.id! };
}

export { parseEmailQueue };
