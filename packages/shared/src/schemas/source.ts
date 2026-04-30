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
  /** On the first sync, look back this many days. Subsequent syncs are
   *  incremental from the last successful sync time. */
  historicalBackfillDays: z.number().int().min(1).max(3650).default(30),
  /** Hard cap per sync run to keep memory bounded. Older messages get the
   *  next pass. 0 = unlimited (not recommended for large mailboxes). */
  maxPerSync: z.number().int().min(0).max(50_000).default(2000),
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

/**
 * Partial update for IMAP. `password` may be omitted to keep the existing
 * encrypted value (we never echo it back to the client).
 */
export const ImapUpdateConfig = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  mailbox: z.string().min(1).optional(),
  pollIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  historicalBackfillDays: z.number().int().min(1).max(3650).optional(),
  maxPerSync: z.number().int().min(0).max(50_000).optional(),
});
export type ImapUpdateConfig = z.infer<typeof ImapUpdateConfig>;

export const SourceUpdateRequest = z.object({
  name: z.string().min(1).optional(),
  config: ImapUpdateConfig.optional(),
  status: z.enum(['active', 'paused']).optional(),
});
export type SourceUpdateRequest = z.infer<typeof SourceUpdateRequest>;

/** Stateless connection test (does not persist). */
export const SourceTestRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('imap'), config: ImapConfig }),
]);
export type SourceTestRequest = z.infer<typeof SourceTestRequest>;

export const SourceTestResponse = z.object({
  ok: z.boolean(),
  mailboxes: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export type SourceTestResponse = z.infer<typeof SourceTestResponse>;
