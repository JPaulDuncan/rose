import { z } from 'zod';

export const SpamPolicy = z.object({
  senders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  blockedSenders: z.array(z.string()).default([]),
});
export type SpamPolicy = z.infer<typeof SpamPolicy>;

export const SpamSenderRequest = z.object({
  address: z.string().min(1).max(320),
});
export type SpamSenderRequest = z.infer<typeof SpamSenderRequest>;

export const BlockSenderRequest = z.object({
  address: z.string().min(1).max(320),
  /** Also wipe any existing emails + the sender's wiki pages. Default
   *  true — blocking usually means "I never want to see this sender". */
  removeExisting: z.boolean().default(true),
});
export type BlockSenderRequest = z.infer<typeof BlockSenderRequest>;

export const SpamTagRequest = z.object({
  tag: z.string().min(1).max(80),
});
export type SpamTagRequest = z.infer<typeof SpamTagRequest>;
