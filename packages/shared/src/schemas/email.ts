import { z } from 'zod';

export const EmailAddress = z.object({
  name: z.string().optional(),
  address: z.string(),
});
export type EmailAddress = z.infer<typeof EmailAddress>;

export const EmailAttachment = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  contentId: z.string().optional(),
  storageKey: z.string().optional(),
});
export type EmailAttachment = z.infer<typeof EmailAttachment>;

export const ParsedEmail = z.object({
  id: z.string(),
  userId: z.string(),
  sourceId: z.string().nullable(),
  messageId: z.string().nullable(),
  threadKey: z.string().nullable(),
  from: EmailAddress.nullable(),
  to: z.array(EmailAddress).default([]),
  cc: z.array(EmailAddress).default([]),
  subject: z.string().default(''),
  date: z.string().nullable(),
  text: z.string().default(''),
  html: z.string().nullable(),
  attachments: z.array(EmailAttachment).default([]),
  rawHash: z.string(),
  ingestStatus: z.enum(['pending', 'parsing', 'parsed', 'generated', 'skipped', 'failed']),
  pageId: z.string().nullable(),
  createdAt: z.string(),
});
export type ParsedEmail = z.infer<typeof ParsedEmail>;
