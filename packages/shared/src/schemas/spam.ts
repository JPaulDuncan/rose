import { z } from 'zod';

export const SpamPolicy = z.object({
  senders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type SpamPolicy = z.infer<typeof SpamPolicy>;

export const SpamSenderRequest = z.object({
  address: z.string().min(1).max(320),
});
export type SpamSenderRequest = z.infer<typeof SpamSenderRequest>;

export const SpamTagRequest = z.object({
  tag: z.string().min(1).max(80),
});
export type SpamTagRequest = z.infer<typeof SpamTagRequest>;
