import { z } from 'zod';

export const SourceType = z.enum(['upload', 'imap', 'webhook', 'gmail']);
export type SourceType = z.infer<typeof SourceType>;

export const ImapConfig = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  username: z.string(),
  password: z.string(),
  mailbox: z.string().default('INBOX'),
  pollIntervalMinutes: z.number().int().min(1).max(1440).default(5),
});
export type ImapConfig = z.infer<typeof ImapConfig>;

export const WebhookConfig = z.object({
  token: z.string(),
});
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export const GmailConfig = z.object({
  refreshToken: z.string(),
  email: z.string().email(),
  labelFilter: z.string().optional(),
});
export type GmailConfig = z.infer<typeof GmailConfig>;

export const Source = z.object({
  id: z.string(),
  userId: z.string(),
  type: SourceType,
  name: z.string(),
  status: z.enum(['active', 'paused', 'error']),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof Source>;

export const SourceCreateRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('imap'), name: z.string().min(1), config: ImapConfig }),
  z.object({ type: z.literal('webhook'), name: z.string().min(1) }),
  z.object({ type: z.literal('gmail'), name: z.string().min(1), authCode: z.string() }),
]);
export type SourceCreateRequest = z.infer<typeof SourceCreateRequest>;
