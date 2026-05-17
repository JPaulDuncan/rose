import { z } from 'zod';

export const SourceType = z.enum([
  'imap',
  'webhook',
  'gmail',
  'rss',
  'slack',
  'discord',
  'gcal',
  'website',
  'ics',
]);
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
   *  incremental from the last successful sync time. `0` is the "pull
   *  everything" sentinel — drops the date filter entirely so the
   *  worker walks the whole mailbox. */
  historicalBackfillDays: z.number().int().min(0).max(3650).default(30),
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

export const RssConfig = z.object({
  url: z.string().url(),
  /** Per-feed override. When omitted the user's global default applies. */
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  /** Skip items older than this many days on first sync. */
  historicalBackfillDays: z.number().int().min(1).max(365).default(14),
  /** Hard cap per sync run. */
  maxPerSync: z.number().int().min(1).max(500).default(100),
});
export type RssConfig = z.infer<typeof RssConfig>;

export const SlackConfig = z.object({
  /** Slack workspace token. xoxb-* (bot) or xoxp-* (user) — operator
   *  picks per their threat model. We never request write scopes. */
  token: z.string().min(10),
  workspaceId: z.string().optional(),
  watchedChannels: z.array(z.string()).default([]),
  cadence: z.enum(['daily', 'weekly']).default('daily'),
  pollIntervalMinutes: z.number().int().min(15).max(1440).default(60),
});
export type SlackConfig = z.infer<typeof SlackConfig>;

export const DiscordConfig = z.object({
  /** Bot token (`Bot xxx`). User installs the Rose bot on their
   *  server, then pastes the token. */
  botToken: z.string().min(20),
  guildId: z.string().min(1),
  watchedChannels: z.array(z.string()).default([]),
  cadence: z.enum(['daily', 'weekly']).default('daily'),
  pollIntervalMinutes: z.number().int().min(15).max(1440).default(60),
});
export type DiscordConfig = z.infer<typeof DiscordConfig>;

export const WebsiteConfig = z.object({
  url: z.string().url(),
  /** How often the worker re-fetches the page. Default: every 6 hours. */
  pollIntervalMinutes: z.number().int().min(15).max(1440).default(360),
  /**
   * Sitemap mode (web-integration Phase 4). When set, the worker
   * treats `url` as a single page AND additionally fetches the
   * referenced sitemap.xml on each tick, queueing every URL it
   * surfaces (deduplicated against the existing Email rows for this
   * source) through fetchAndParse. Use this to track "every new
   * article under apnews.com/world" without listing each URL by
   * hand. Bounded by `sitemapMaxUrlsPerSync` so a 50k-entry sitemap
   * doesn't drown the queue on first run.
   */
  sitemapUrl: z.string().url().optional(),
  /** Hard cap on URLs queued from a single sitemap pull. */
  sitemapMaxUrlsPerSync: z.number().int().min(1).max(500).default(50),
});
export type WebsiteConfig = z.infer<typeof WebsiteConfig>;

export const WebsiteUpdateConfig = z.object({
  url: z.string().url().optional(),
  pollIntervalMinutes: z.number().int().min(15).max(1440).optional(),
  sitemapUrl: z.string().url().nullable().optional(),
  sitemapMaxUrlsPerSync: z.number().int().min(1).max(500).optional(),
});
export type WebsiteUpdateConfig = z.infer<typeof WebsiteUpdateConfig>;

export const GcalConfig = z.object({
  /** Set on initial connect; the worker exchanges it once for a
   *  refresh token, then clears it. */
  authCode: z.string().optional(),
  /** Comma-separated calendar IDs to pull. Empty = primary only. */
  calendarIds: z.array(z.string()).default([]),
  pollIntervalMinutes: z.number().int().min(5).max(1440).default(15),
});
export type GcalConfig = z.infer<typeof GcalConfig>;

/**
 * Public-calendar subscription via an ICS feed URL. The user pastes
 * any of:
 *   - A Google share link with `?cid=<base64-calendar-id>`
 *   - A direct `https://.../foo.ics` URL (Apple, Outlook, Nextcloud,
 *     anything that exposes RFC 5545)
 *   - A `webcal://...` URL (we treat as https://)
 *
 * The API normalises whatever was pasted to a canonical https URL
 * via `normalizeCalendarUrl` before persisting. Unlike `gcal` this
 * path never sees the user's credentials — it only works against
 * calendars the owner has explicitly made public. Private Google
 * calendars need the OAuth path.
 */
export const IcsConfig = z.object({
  /** Original input the user pasted. Stored verbatim so the edit
   *  affordance can re-display it. */
  url: z.string().min(1).max(2000),
  /** Resolved ICS endpoint after `normalizeCalendarUrl`. The worker
   *  fetches THIS, not `url`. */
  resolvedUrl: z.string().url().max(2000),
  /** Polling cadence. Default once per hour — calendars don't change
   *  as fast as RSS feeds. */
  pollIntervalMinutes: z.number().int().min(15).max(1440).default(60),
  /** Events whose start is more than this many days in the past are
   *  ignored on ingest. Keeps a 10-year holiday calendar from
   *  flooding the events collection. */
  historicalBackfillDays: z.number().int().min(1).max(3650).default(365),
  /** Hard cap on VEVENTs ingested per sync. The next pass picks up
   *  anything that overflowed. */
  maxPerSync: z.number().int().min(1).max(5000).default(1000),
});
export type IcsConfig = z.infer<typeof IcsConfig>;

export const IcsUpdateConfig = z.object({
  url: z.string().min(1).max(2000).optional(),
  pollIntervalMinutes: z.number().int().min(15).max(1440).optional(),
  historicalBackfillDays: z.number().int().min(1).max(3650).optional(),
  maxPerSync: z.number().int().min(1).max(5000).optional(),
});
export type IcsUpdateConfig = z.infer<typeof IcsUpdateConfig>;

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
  z.object({
    type: z.literal('gmail'),
    name: z.string().min(1),
    authCode: z.string(),
    pollIntervalMinutes: z.number().int().min(1).max(1440).default(5),
  }),
  z.object({ type: z.literal('rss'), name: z.string().min(1), config: RssConfig }),
  z.object({ type: z.literal('slack'), name: z.string().min(1), config: SlackConfig }),
  z.object({ type: z.literal('discord'), name: z.string().min(1), config: DiscordConfig }),
  z.object({ type: z.literal('gcal'), name: z.string().min(1), config: GcalConfig }),
  z.object({ type: z.literal('website'), name: z.string().min(1), config: WebsiteConfig }),
  z.object({
    type: z.literal('ics'),
    name: z.string().min(1),
    /** `resolvedUrl` is derived server-side from `url`; clients only
     *  send the user-facing input. */
    config: IcsConfig.omit({ resolvedUrl: true }),
  }),
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
  /** 0 = pull everything; otherwise capped at 3650. */
  historicalBackfillDays: z.number().int().min(0).max(3650).optional(),
  maxPerSync: z.number().int().min(0).max(50_000).optional(),
});
export type ImapUpdateConfig = z.infer<typeof ImapUpdateConfig>;

export const RssUpdateConfig = z.object({
  url: z.string().url().optional(),
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  historicalBackfillDays: z.number().int().min(1).max(365).optional(),
  maxPerSync: z.number().int().min(1).max(500).optional(),
});
export type RssUpdateConfig = z.infer<typeof RssUpdateConfig>;

export const SourceUpdateRequest = z.object({
  name: z.string().min(1).optional(),
  config: ImapUpdateConfig.optional(),
  rssConfig: RssUpdateConfig.optional(),
  websiteConfig: WebsiteUpdateConfig.optional(),
  icsConfig: IcsUpdateConfig.optional(),
  status: z.enum(['active', 'paused']).optional(),
  /** Top-level interval — accepted for any pollable source (IMAP / Gmail / RSS / Website / ICS). */
  pollIntervalMinutes: z.number().int().min(1).max(1440).optional(),
});
export type SourceUpdateRequest = z.infer<typeof SourceUpdateRequest>;

/** Stateless connection test (does not persist). */
export const SourceTestRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('imap'), config: ImapConfig }),
  z.object({ type: z.literal('rss'), config: z.object({ url: z.string().url() }) }),
  z.object({ type: z.literal('website'), config: z.object({ url: z.string().url() }) }),
  z.object({
    type: z.literal('slack'),
    config: z.object({ token: z.string().min(10) }),
  }),
  z.object({
    type: z.literal('discord'),
    config: z.object({ botToken: z.string().min(20), guildId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('ics'),
    config: z.object({ url: z.string().min(1).max(2000) }),
  }),
]);
export type SourceTestRequest = z.infer<typeof SourceTestRequest>;

export const SourceTestResponse = z.object({
  ok: z.boolean(),
  mailboxes: z.array(z.string()).optional(),
  /** Sample of feed entry titles when testing an RSS source. */
  feedTitle: z.string().optional(),
  sampleItems: z.array(z.object({ title: z.string(), link: z.string().nullable() })).optional(),
  /** Page title + snippet when testing a website source. */
  pageTitle: z.string().optional(),
  snippet: z.string().optional(),
  /** Resolved URL after redirects (website test). */
  finalUrl: z.string().optional(),
  /** Slack/Discord workspace info + channels list. */
  workspaceName: z.string().optional(),
  channels: z
    .array(z.object({ id: z.string(), name: z.string(), isPrivate: z.boolean().optional() }))
    .optional(),
  /** ICS test fields. `calendarName` is the X-WR-CALNAME or PRODID
   *  from the feed; `sampleEvents` is the first few VEVENT summaries. */
  calendarName: z.string().optional(),
  sampleEvents: z
    .array(z.object({ title: z.string(), start: z.string().nullable() }))
    .optional(),
  resolvedUrl: z.string().optional(),
  message: z.string().optional(),
});
export type SourceTestResponse = z.infer<typeof SourceTestResponse>;
