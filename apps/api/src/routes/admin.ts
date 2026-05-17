import { Router } from 'express';
import {
  ApiToken,
  BayesProfile,
  CalendarEvent,
  Category,
  Conversation,
  DaydreamNote,
  WeatherSnapshot,
  Recipe,
  RecipeAudit,
  Email,
  Entity,
  LibraryDocument,
  LibraryDocumentRef,
  LibrarySource,
  Message,
  NotificationRule,
  OutboundMessage,
  Page,
  PageRevision,
  ProductPurchase,
  PushSubscription,
  Rule,
  RuleAuditLog,
  Sender,
  SenderBrand,
  ShareLink,
  Source,
  Subscription,
  TagCanonical,
  TagDigest,
  EntityRelation,
  User,
  UserPageState,
  WebhookSubscription,
} from '@rose/db';
import {
  backfillQueue,
  parseEmailQueue,
  generatePageQueue,
  embedPageQueue,
  imapSyncQueue,
  gmailSyncQueue,
  rssSyncQueue,
  websiteSyncQueue,
  icsSyncQueue,
  daydreamQueue,
  topicResearchQueue,
  postWriteHooksQueue,
  recipesQueue,
  briefingQueue,
  webhookDeliverQueue,
  sendOutboundQueue,
  digestEmailQueue,
  summarizeSenderQueue,
  fetchAndParseQueue,
  slackSyncQueue,
  discordSyncQueue,
  gcalSyncQueue,
  librarySyncQueue,
  libraryEmbedQueue,
  tagDigestQueue,
} from '../lib/queues.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { isAdminRequest, requireAdmin } from '../middleware/admin.js';
import { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { SWEEPER_CATALOG } from '@rose/shared';

export const adminRouter: Router = Router();

/**
 * Plan 16 — admin landing fetch. Tells the SPA whether the
 * current user is the admin (so it can show / hide the
 * Settings → Admin tab) without exposing other admin info.
 *
 * Mounted alongside (not inside) `requireAdmin` so non-admins get
 * a 200 with `isAdmin: false` rather than a 403 from the gate
 * middleware — the SPA reads this on every settings-page mount
 * and we don't want logs full of expected 403s.
 */
adminRouter.get('/me', async (req, res) => {
  const isAdmin = await isAdminRequest(req);
  res.json({ isAdmin });
});

/**
 * Catalog of resettable scopes. Each entry's `run` callback is
 * what the reset endpoint executes when that checkbox is ticked.
 * Order matters for some scopes (revisions come out before the
 * page rows they reference, etc.) — we sort by the listed
 * order, not the request payload's order.
 */
type ScopeRunner = () => Promise<{ deleted: number }>;
type Scope = {
  id: string;
  group: 'global' | 'content' | 'metadata' | 'subscriptions' | 'infrastructure';
  label: string;
  description: string;
  run: ScopeRunner;
};

async function deleteAllAndReport<T extends { deleteMany: (filter?: object) => { deletedCount?: number | null } | Promise<{ deletedCount?: number | null }> }>(
  Model: T,
): Promise<{ deleted: number }> {
  const r = await Model.deleteMany({});
  return { deleted: r.deletedCount ?? 0 };
}

const SCOPES: Scope[] = [
  // ── Global knowledge ───────────────────────────────────────
  {
    id: 'daydream-notes',
    group: 'global',
    label: 'Daydream notes',
    description:
      'Encyclopedic context the daydream system has researched. Affects every user; future regenerations rebuild from external sources.',
    run: () => deleteAllAndReport(DaydreamNote),
  },
  {
    id: 'sender-brands',
    group: 'global',
    label: 'Sender brands',
    description:
      'Brand-global names, logos, and "who is this" briefs. Affects every user; the worker rebuilds these from incoming mail.',
    run: () => deleteAllAndReport(SenderBrand),
  },
  {
    id: 'weather-snapshots',
    group: 'global',
    label: 'Weather snapshots',
    description:
      'Per-fetch weather observations that drive the trend chart on /weather. Dropping these resets the chart; new data accumulates as the home weather panel polls.',
    run: () => deleteAllAndReport(WeatherSnapshot),
  },

  // ── Content (all users) ────────────────────────────────────
  {
    id: 'pages',
    group: 'content',
    label: 'Wiki pages + revisions',
    description:
      'All Page docs and their revision history across all users. Generated again as new emails arrive.',
    run: async () => {
      const r1 = await PageRevision.deleteMany({});
      const r2 = await Page.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'emails',
    group: 'content',
    label: 'Emails (raw + parsed)',
    description:
      'Every email document. Source connectors will refetch on next sync. Pages reference these — clearing emails without clearing pages leaves citations dangling.',
    run: () => deleteAllAndReport(Email),
  },
  {
    id: 'events',
    group: 'content',
    label: 'Calendar events',
    description: 'Extracted future events. Re-extracted as the worker re-runs.',
    run: () => deleteAllAndReport(CalendarEvent),
  },
  {
    id: 'conversations',
    group: 'content',
    label: 'Conversations + chat messages',
    description: 'Persisted chat sessions and their messages.',
    run: async () => {
      const r1 = await Message.deleteMany({});
      const r2 = await Conversation.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'library',
    group: 'content',
    label: 'Library documents',
    description:
      'Global library docs + every user\'s refs. Library sources stay; docs get re-fetched on next sync.',
    run: async () => {
      const r1 = await LibraryDocumentRef.deleteMany({});
      const r2 = await LibraryDocument.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'outbound',
    group: 'content',
    label: 'Outbound drafts + audit',
    description: 'Reply drafts and the audit log of sent messages.',
    run: () => deleteAllAndReport(OutboundMessage),
  },

  // ── Per-user metadata ──────────────────────────────────────
  {
    id: 'senders',
    group: 'metadata',
    label: 'Per-user sender state',
    description:
      'Every user\'s per-sender counters, overrides, and reputation. Brand-global rows live in "Sender brands" above.',
    run: () => deleteAllAndReport(Sender),
  },
  {
    id: 'entities',
    group: 'metadata',
    label: 'Entity registry',
    description:
      'Per-user named-entity directory (people, works, organizations, places). Pages keep their `entities[]`; the directory rebuilds on next page generation.',
    run: () => deleteAllAndReport(Entity),
  },
  {
    id: 'tag-canonicals',
    group: 'metadata',
    label: 'Tag canonicals',
    description:
      'Global tag synonym registry. Page tags stay; the canonicalisation table rebuilds on next page write.',
    run: () => deleteAllAndReport(TagCanonical),
  },
  {
    id: 'categories',
    group: 'metadata',
    label: 'Categories',
    description: 'Folder-like taxonomy. LLM repopulates on next page write.',
    run: () => deleteAllAndReport(Category),
  },
  {
    id: 'rules',
    group: 'metadata',
    label: 'User filter rules',
    description: 'Per-user automation rules + their audit log.',
    run: async () => {
      const r1 = await RuleAuditLog.deleteMany({});
      const r2 = await Rule.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'recipes',
    group: 'metadata',
    label: 'Recipes (IFTTT automations)',
    description:
      'User recipes + their audit log. Time-scheduled BullMQ repeatables are not removed here — restart the worker after a wipe to clear stragglers.',
    run: async () => {
      const r1 = await RecipeAudit.deleteMany({});
      const r2 = await Recipe.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'tag-digests',
    group: 'metadata',
    label: 'Tag digests',
    description: 'Daily tag-section briefs cached on the home edition.',
    run: () => deleteAllAndReport(TagDigest),
  },
  {
    id: 'bayes-profiles',
    group: 'metadata',
    label: 'Bayes profiles',
    description: 'Per-user spam classifier training data. Cold-starts on next email.',
    run: () => deleteAllAndReport(BayesProfile),
  },
  {
    id: 'page-state',
    group: 'metadata',
    label: 'Read state',
    description: 'Per-user page-read positions / star markers.',
    run: () => deleteAllAndReport(UserPageState),
  },
  {
    id: 'share-links',
    group: 'metadata',
    label: 'Share links',
    description: 'All public-render share tokens.',
    run: () => deleteAllAndReport(ShareLink),
  },
  {
    id: 'saved-searches',
    group: 'metadata',
    label: 'Saved searches + featured tags',
    description:
      'Embedded in every User document. Clears `savedSearches[]`, `featuredTags[]`, and `weatherLocations[]` for every user.',
    run: async () => {
      const r = await User.updateMany(
        {},
        {
          $set: { savedSearches: [], featuredTags: [], weatherLocations: [] },
          // Drop the legacy singular field too, in case any old rows
          // still carry it.
          $unset: { weatherLocation: 1 },
        },
      );
      return { deleted: r.modifiedCount ?? 0 };
    },
  },

  // ── Subscriptions / sources (DESTRUCTIVE) ─────────────────
  {
    id: 'sources',
    group: 'subscriptions',
    label: 'Email sources (DESTROYS CREDENTIALS)',
    description:
      'IMAP / Gmail / RSS / Slack / Discord / Calendar / Library source configs. Encrypted credentials go with them — every user has to re-link their accounts.',
    run: async () => {
      const r1 = await Source.deleteMany({});
      const r2 = await LibrarySource.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'webhooks',
    group: 'subscriptions',
    label: 'Webhook subscriptions',
    description: 'Outbound event subscriptions and their delivery audit.',
    run: () => deleteAllAndReport(WebhookSubscription),
  },
  {
    id: 'push',
    group: 'subscriptions',
    label: 'Push notification registrations',
    description:
      'Browser / device WebPush endpoints + per-user notification rules. Users have to re-register from their device.',
    run: async () => {
      const r1 = await PushSubscription.deleteMany({});
      const r2 = await NotificationRule.deleteMany({});
      return { deleted: (r1.deletedCount ?? 0) + (r2.deletedCount ?? 0) };
    },
  },
  {
    id: 'api-tokens',
    group: 'subscriptions',
    label: 'API tokens',
    description:
      'OAuth / inbound-webhook tokens. Anyone using them to push email in or call the API will need new ones.',
    run: () => deleteAllAndReport(ApiToken),
  },

  // ── Infrastructure ────────────────────────────────────────
  {
    id: 'queues',
    group: 'infrastructure',
    label: 'BullMQ job queues',
    description:
      'In-flight + completed jobs across every worker queue. Stuck pipelines clear; legitimate work-in-progress is lost too — only run when pipelines are quiet.',
    run: async () => {
      // Targeted obliterate of every Rose-namespaced queue. Keys
      // follow `bull:rose.<name>:*` so a single SCAN handles them.
      let cursor = '0';
      let cleared = 0;
      do {
        const [next, batch] = (await redis.scan(
          cursor,
          'MATCH',
          'bull:rose.*',
          'COUNT',
          200,
        )) as [string, string[]];
        cursor = next;
        if (batch.length > 0) {
          cleared += batch.length;
          await redis.del(...batch);
        }
      } while (cursor !== '0');
      return { deleted: cleared };
    },
  },
  {
    id: 'caches',
    group: 'infrastructure',
    label: 'Redis caches',
    description:
      'webFetch cache, rate-limit counters, idle-activity timestamps, daily-cap counters. Forces every cached call to round-trip again.',
    run: async () => {
      let cursor = '0';
      let cleared = 0;
      // Match the prefixes used across the codebase: webFetch (no
      // explicit prefix; we use the `webcache:` prefix from
      // webFetchCache.ts), rl: (rate limits), rose:idle:, rose:dailycap:.
      const patterns = ['webcache:*', 'rl:*', 'rose:idle:*', 'rose:dailycap:*'];
      for (const pattern of patterns) {
        cursor = '0';
        do {
          const [next, batch] = (await redis.scan(
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            200,
          )) as [string, string[]];
          cursor = next;
          if (batch.length > 0) {
            cleared += batch.length;
            await redis.del(...batch);
          }
        } while (cursor !== '0');
      }
      return { deleted: cleared };
    },
  },
];

const SCOPE_BY_ID = new Map(SCOPES.map((s) => [s.id, s]));

/**
 * Catalog endpoint — UI reads the list to render checkboxes.
 * Includes the same descriptions surfaced inline so the SPA
 * doesn't have to re-state them.
 */
/**
 * Extraction coverage stats. Aggregates structured-vs-LLM ratios
 * across the four extractors that gained fast paths (receipts,
 * subscriptions, daydream notes, entity relations) so the admin
 * can see where the LLM is still firing and prioritise backfills.
 *
 * Counts are global (cross-user) because the underlying
 * collections are global (Product / DaydreamNote / EntityRelation)
 * and because the cost-saving question is deployment-wide rather
 * than per-user.
 */
adminRouter.get('/extraction-stats', requireAdmin, async (_req, res, next) => {
  try {
    const [
      purchaseTotal,
      purchaseStructured,
      purchaseVendor,
      subTotal,
      subStructured,
      noteTotal,
      noteWikipedia,
      relTotal,
      relWikidata,
      pageTotal,
      pagesWithRelations,
      receiptPages,
    ] = await Promise.all([
      ProductPurchase.countDocuments({}),
      ProductPurchase.countDocuments({ extractedBy: 'structured' }),
      ProductPurchase.countDocuments({ extractedBy: 'vendor' }),
      Subscription.countDocuments({}),
      Subscription.countDocuments({ extractedBy: 'structured' }),
      DaydreamNote.countDocuments({}),
      DaydreamNote.countDocuments({ model: 'wikipedia:verbatim' }),
      EntityRelation.countDocuments({}),
      EntityRelation.countDocuments({ wikidataConfirmed: true }),
      Page.countDocuments({}),
      Page.countDocuments({ relationsExtractedFromHash: { $ne: null } }),
      Page.countDocuments({
        $or: [
          { tags: { $in: ['receipt', 'receipts', 'invoice', 'invoices', 'order'] } },
          { topics: { $in: ['receipt', 'receipts', 'invoice', 'invoices', 'order'] } },
        ],
      }),
    ]);
    function ratio(n: number, d: number): number {
      return d > 0 ? Math.round((n / d) * 1000) / 1000 : 0;
    }
    res.json({
      purchases: {
        total: purchaseTotal,
        structured: purchaseStructured,
        vendor: purchaseVendor,
        llm: purchaseTotal - purchaseStructured - purchaseVendor,
        // Combined fast-path ratio — anything not LLM is a win.
        // The UI splits structured / vendor into two stacked bars
        // so the admin can see vendor-parser coverage separately.
        structuredRatio: ratio(
          purchaseStructured + purchaseVendor,
          purchaseTotal,
        ),
        candidatePages: receiptPages,
      },
      subscriptions: {
        total: subTotal,
        structured: subStructured,
        llm: subTotal - subStructured,
        structuredRatio: ratio(subStructured, subTotal),
      },
      daydream: {
        total: noteTotal,
        wikipediaVerbatim: noteWikipedia,
        llm: noteTotal - noteWikipedia,
        verbatimRatio: ratio(noteWikipedia, noteTotal),
      },
      relations: {
        total: relTotal,
        wikidataConfirmed: relWikidata,
        archiveOnly: relTotal - relWikidata,
        wikidataRatio: ratio(relWikidata, relTotal),
      },
      pages: {
        total: pageTotal,
        withRelationsExtracted: pagesWithRelations,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Per-queue depth snapshot. The admin UI polls this on a 5s timer
 * to render a small status pill ("12 jobs in flight" + colour
 * cue). Reads job counts directly from BullMQ — cheap (Redis hash
 * lookups), no Mongo touch.
 *
 * Response shape:
 *   {
 *     totals: { waiting, active, delayed, failed },
 *     queues: [{ name, waiting, active, delayed, completed?, failed }, ...]
 *   }
 * Totals collapse the per-queue numbers into one row so the
 * polling pill can render without iterating client-side.
 */
adminRouter.get('/queue-stats', requireAdmin, async (_req, res, next) => {
  try {
    const queueList = [
      { name: 'parse-email', q: parseEmailQueue },
      { name: 'generate-page', q: generatePageQueue },
      { name: 'embed-page', q: embedPageQueue },
      { name: 'imap-sync', q: imapSyncQueue },
      { name: 'gmail-sync', q: gmailSyncQueue },
      { name: 'rss-sync', q: rssSyncQueue },
      { name: 'website-sync', q: websiteSyncQueue },
      { name: 'ics-sync', q: icsSyncQueue },
      { name: 'daydream', q: daydreamQueue },
      { name: 'topic-research', q: topicResearchQueue },
      { name: 'post-write-hooks', q: postWriteHooksQueue },
      { name: 'recipes', q: recipesQueue },
      { name: 'backfill', q: backfillQueue },
      { name: 'briefing', q: briefingQueue },
      { name: 'webhook-deliver', q: webhookDeliverQueue },
      { name: 'send-outbound', q: sendOutboundQueue },
      { name: 'digest-email', q: digestEmailQueue },
      { name: 'summarize-sender', q: summarizeSenderQueue },
      { name: 'fetch-and-parse', q: fetchAndParseQueue },
      { name: 'slack-sync', q: slackSyncQueue },
      { name: 'discord-sync', q: discordSyncQueue },
      { name: 'gcal-sync', q: gcalSyncQueue },
      { name: 'library-sync', q: librarySyncQueue },
      { name: 'library-embed', q: libraryEmbedQueue },
      { name: 'tag-digest', q: tagDigestQueue },
    ];
    const rows = await Promise.all(
      queueList.map(async ({ name, q }) => {
        try {
          const counts = await q.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
          );
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch (err) {
          // A single dead queue shouldn't fail the whole panel.
          // Log + emit zeros so the UI can still render the rest.
          logger.warn({ err, name }, 'queue-stats: getJobCounts failed');
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0 };
        }
      }),
    );
    const totals = rows.reduce(
      (acc, r) => ({
        waiting: acc.waiting + r.waiting,
        active: acc.active + r.active,
        delayed: acc.delayed + r.delayed,
        failed: acc.failed + r.failed,
      }),
      { waiting: 0, active: 0, delayed: 0, failed: 0 },
    );
    res.json({ totals, queues: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Single admin landing for "everything Rose runs on a schedule."
 * Two distinct sources are unified here:
 *
 *   1. BullMQ repeatables: paginated `getRepeatableJobs` across every
 *      known queue. The job's `key` (BullMQ's internal storage key)
 *      and `id` (the friendly jobId we set on enqueue) compose into
 *      a category — recipe crons get `cron:<recipeId>` jobIds,
 *      source polls get `<type>:<sourceId>`, system sweeps use
 *      stable names like `digest:sweep`. Each is enriched against
 *      the relevant Mongo collection (Recipe / Source) so the admin
 *      sees a human label and the owning user, not just an ObjectId.
 *
 *   2. In-process setInterval sweepers: declared in
 *      `@rose/shared`'s SWEEPER_CATALOG because they run inside the
 *      worker process and aren't visible through any Redis query.
 *      We surface them as "system / in-process" rows so the admin
 *      sees a complete picture of what's scheduled, even if "next
 *      run" can only be shown for the BullMQ-backed ones.
 *
 * Returns under 400ms in steady state — pagination caps each queue
 * at 1000 entries per page and we only hit Mongo twice (one Recipe
 * bulk-fetch, one Source bulk-fetch).
 */
adminRouter.get('/cron-jobs', requireAdmin, async (_req, res, next) => {
  try {
    type RepeatableRow = {
      source: 'recipe' | 'source-poll' | 'system' | 'unknown';
      queue: string;
      jobId: string | null;
      key: string;
      jobName: string;
      pattern: string | null;
      every: number | null;
      tz: string | null;
      next: number | null;
      /** Display label resolved from the enrichment lookup. */
      label: string;
      /** Email of the owning user when known (recipe owner, source
       *  owner). null for system sweeps. */
      ownerEmail: string | null;
      /** Whether the recipe is enabled (only meaningful for `recipe`
       *  rows; null for everything else). */
      enabled: boolean | null;
    };

    // Every queue name that might carry a repeatable. Includes the
    // permanent Queue handles already exported from queues.ts plus
    // the two worker-internal queues (cleanup, weather-snapshot)
    // that the API doesn't otherwise reference. Ephemeral Queue
    // handles point at the same Redis keys as the worker's.
    const QUEUES: { name: string; q: Queue; ephemeral: boolean }[] = [
      { name: 'rose.recipes', q: recipesQueue, ephemeral: false },
      { name: 'rose.imap-sync', q: imapSyncQueue, ephemeral: false },
      { name: 'rose.gmail-sync', q: gmailSyncQueue, ephemeral: false },
      { name: 'rose.rss-sync', q: rssSyncQueue, ephemeral: false },
      { name: 'rose.website-sync', q: websiteSyncQueue, ephemeral: false },
      { name: 'rose.ics-sync', q: icsSyncQueue, ephemeral: false },
      { name: 'rose.slack-sync', q: slackSyncQueue, ephemeral: false },
      { name: 'rose.discord-sync', q: discordSyncQueue, ephemeral: false },
      { name: 'rose.gcal-sync', q: gcalSyncQueue, ephemeral: false },
      { name: 'rose.library-sync', q: librarySyncQueue, ephemeral: false },
      { name: 'rose.digest-email', q: digestEmailQueue, ephemeral: false },
      { name: 'rose.briefing', q: briefingQueue, ephemeral: false },
      { name: 'rose.tag-digest', q: tagDigestQueue, ephemeral: false },
      {
        name: 'rose.cleanup',
        q: new Queue('rose.cleanup', { connection: redis }),
        ephemeral: true,
      },
      {
        name: 'rose.weather-snapshot',
        q: new Queue('rose.weather-snapshot', { connection: redis }),
        ephemeral: true,
      },
    ];

    const all: RepeatableRow[] = [];
    const recipeIds = new Set<string>();
    const sourceIds = new Set<string>();
    try {
      for (const { name, q } of QUEUES) {
        const PAGE = 1000;
        for (let start = 0; ; start += PAGE) {
          let batch: Awaited<ReturnType<Queue['getRepeatableJobs']>>;
          try {
            batch = await q.getRepeatableJobs(start, start + PAGE - 1, true);
          } catch (err) {
            logger.warn({ err, queue: name }, 'cron-jobs: getRepeatableJobs failed');
            break;
          }
          for (const r of batch) {
            const jobId = r.id ?? null;
            // Classify the row by jobId convention.
            let source: RepeatableRow['source'] = 'unknown';
            if (name === 'rose.recipes' && jobId?.startsWith('cron:')) {
              source = 'recipe';
              recipeIds.add(jobId.slice('cron:'.length));
            } else if (
              /^rose\.(imap|gmail|rss|website|ics|slack|discord|gcal)-sync$/.test(name) &&
              jobId &&
              jobId.includes(':')
            ) {
              source = 'source-poll';
              sourceIds.add(jobId.split(':')[1]!);
            } else if (jobId && /:sweep$/.test(jobId)) {
              source = 'system';
            }
            all.push({
              source,
              queue: name,
              jobId,
              key: r.key,
              jobName: r.name,
              pattern: r.pattern ?? null,
              every:
                typeof r.every === 'number'
                  ? r.every
                  : r.every
                    ? Number(r.every)
                    : null,
              tz: r.tz ?? null,
              next: r.next ?? null,
              label: jobId ?? r.key,
              ownerEmail: null,
              enabled: null,
            });
          }
          if (batch.length < PAGE) break;
        }
      }
    } finally {
      // Close ephemeral handles only — long-lived ones stay open.
      for (const { q, ephemeral } of QUEUES) {
        if (ephemeral) await q.close().catch(() => null);
      }
    }

    // Bulk-enrich recipe + source rows. Two queries, irrespective
    // of how many repeatables there are.
    type RecipeRow = {
      _id: Types.ObjectId;
      name: string;
      enabled: boolean;
      scope: 'user' | 'global';
      userId: Types.ObjectId;
    };
    type SourceRow = {
      _id: Types.ObjectId;
      name: string;
      type: string;
      userId: Types.ObjectId;
    };
    const recipeRows = recipeIds.size
      ? ((await Recipe.find({
          _id: { $in: [...recipeIds].map((id) => new Types.ObjectId(id)) },
        })
          .select('name enabled scope userId')
          .lean()) as RecipeRow[])
      : [];
    const sourceRows = sourceIds.size
      ? ((await Source.find({
          _id: { $in: [...sourceIds].map((id) => new Types.ObjectId(id)) },
        })
          .select('name type userId')
          .lean()) as SourceRow[])
      : [];
    const recipeById = new Map(recipeRows.map((r) => [String(r._id), r]));
    const sourceById = new Map(sourceRows.map((s) => [String(s._id), s]));
    // Owning user IDs across both — single User lookup for emails.
    const userIds = new Set<string>();
    for (const r of recipeRows) userIds.add(String(r.userId));
    for (const s of sourceRows) userIds.add(String(s.userId));
    type UserRow = { _id: Types.ObjectId; email: string };
    const userRows = userIds.size
      ? ((await User.find({
          _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) },
        })
          .select('email')
          .lean()) as UserRow[])
      : [];
    const emailById = new Map(userRows.map((u) => [String(u._id), u.email]));

    for (const row of all) {
      if (row.source === 'recipe' && row.jobId) {
        const recipeId = row.jobId.slice('cron:'.length);
        const r = recipeById.get(recipeId);
        if (r) {
          row.label = `${r.name}${r.scope === 'global' ? ' (global)' : ''}`;
          row.ownerEmail = emailById.get(String(r.userId)) ?? null;
          row.enabled = r.enabled;
        } else {
          // Repeatable exists in Redis but the Recipe row is gone —
          // either deleted recently with a stale schedule, or
          // schema drift. Flag it so the admin can clean up.
          row.label = `${row.jobId} (orphaned — no Recipe row)`;
        }
      } else if (row.source === 'source-poll' && row.jobId) {
        const sourceId = row.jobId.split(':')[1] ?? '';
        const s = sourceById.get(sourceId);
        if (s) {
          row.label = `${s.name} (${s.type})`;
          row.ownerEmail = emailById.get(String(s.userId)) ?? null;
        } else {
          row.label = `${row.jobId} (orphaned — no Source row)`;
        }
      }
    }

    // In-process catalog — appended verbatim so the UI can render
    // both halves in one table. `pool` lets the admin filter by
    // worker process when something looks off.
    const inProcess = SWEEPER_CATALOG.map((s) => ({ ...s }));

    // Sort: in-flight BullMQ rows by next-fire ascending (soonest
    // first); rows without a `next` (typically every-only repeatables
    // BullMQ hasn't seeded yet) drift to the end.
    const ranked = [...all].sort((a, b) => {
      if (a.next === null && b.next === null) return a.queue.localeCompare(b.queue);
      if (a.next === null) return 1;
      if (b.next === null) return -1;
      return a.next - b.next;
    });

    res.json({
      bullmq: ranked,
      inProcess,
      totals: {
        bullmq: all.length,
        inProcess: inProcess.length,
        orphaned: all.filter((r) => r.label.includes('orphaned')).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Trigger a backfill — re-run an extractor across pages it hasn't
 * touched yet. Idempotent: every extractor short-circuits via its
 * own content-hash gate, so re-running on already-extracted pages
 * is a no-op. The point is to give pages from BEFORE an extractor
 * existed a chance to upgrade.
 *
 * Body:
 *   { kind: 'receipt' | 'subscription' | 'relations' | 'daydream' | 'all',
 *     sinceDays?: number }
 *
 * Pages are enqueued onto the `rose.backfill` queue and processed
 * by the dedicated worker; this endpoint returns immediately with
 * the enqueue count so the admin can move on. Cap of 10_000 pages
 * per request to keep one backfill from monopolising the queue.
 */
adminRouter.post('/backfill', requireAdmin, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { kind?: string; sinceDays?: number };
    const validKinds = new Set([
      'receipt',
      'subscription',
      'relations',
      'daydream',
      'outbound-links',
      'all',
    ]);
    if (!body.kind || !validKinds.has(body.kind)) {
      res.status(400).json({
        error: 'invalid_request',
        message:
          'kind must be one of receipt, subscription, relations, daydream, outbound-links, all',
      });
      return;
    }
    const since = body.sinceDays
      ? new Date(
          Date.now() -
            Math.min(3650, Math.max(1, body.sinceDays)) *
              24 *
              60 *
              60 *
              1000,
        )
      : null;
    const filter: Record<string, unknown> = {};
    if (since) filter.updatedAt = { $gte: since };

    // Narrow the candidate set per kind so we don't enqueue pages
    // the extractor wouldn't touch anyway. Receipts + subscriptions
    // look only at pages tagged accordingly; relations + daydream
    // run on every page with substantive body content.
    if (body.kind === 'receipt') {
      filter.$or = [
        {
          tags: {
            $in: ['receipt', 'receipts', 'invoice', 'invoices', 'order'],
          },
        },
        {
          topics: {
            $in: ['receipt', 'receipts', 'invoice', 'invoices', 'order'],
          },
        },
      ];
    } else if (body.kind === 'subscription') {
      filter.$or = [
        {
          tags: {
            $in: ['subscription', 'subscriptions', 'renewal', 'membership'],
          },
        },
        {
          topics: {
            $in: ['subscription', 'subscriptions', 'renewal', 'membership'],
          },
        },
      ];
    }

    const pages = await Page.find(filter)
      .select('_id userId')
      .sort({ updatedAt: -1 })
      .limit(10_000)
      .lean();

    let enqueued = 0;
    for (const p of pages) {
      try {
        await backfillQueue.add(
          'backfill',
          {
            kind: body.kind,
            userId: String(p.userId),
            pageId: String(p._id),
          },
          {
            // jobId collision = collapse to one job for same
            // (page, kind) pair so a double-click doesn't fan out.
            jobId: `backfill__${body.kind}__${String(p._id)}`,
            attempts: 1,
            removeOnComplete: 500,
            removeOnFail: 500,
            // Backfills run BEHIND real-time work — generation
            // jobs queue at priority 0, this at 100.
            priority: 100,
          },
        );
        enqueued += 1;
      } catch {
        // Same-jobId rejections are expected and counted as
        // already-enqueued.
      }
    }
    res.status(202).json({
      ok: true,
      kind: body.kind,
      candidatePages: pages.length,
      enqueued,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sister endpoint to /backfill for entity-shaped jobs. Walks the
 * Entity collection across every user, picks rows of type
 * person/place that haven't been resolved yet (or whose last
 * resolve attempt was over 90 days ago), and enqueues one
 * `kind: 'entity-wikidata'` job each. The backfill processor runs
 * the existing `enrichEntityWikidata` helper, which fans out to
 * the SPARQL relation enricher on success.
 *
 * Cap of 5_000 entities per request — Wikidata is rate-limited and
 * each resolve does a fetch on cache miss, so a single sweep
 * trades latency for politeness.
 */
adminRouter.post('/backfill-entities', requireAdmin, async (_req, res, next) => {
  try {
    const REFRESH_MS = 90 * 24 * 3600 * 1000;
    const cutoff = new Date(Date.now() - REFRESH_MS);
    const rows = await Entity.find({
      type: { $in: ['person', 'place'] },
      $or: [
        { wikidataId: { $in: [null, undefined] } },
        { wikidataResolvedAt: { $in: [null, undefined] } },
        { wikidataResolvedAt: { $lt: cutoff } },
      ],
    })
      .select('_id userId key type wikidataResolvedAt')
      .sort({ pageCount: -1, updatedAt: -1 })
      .limit(5000)
      .lean();

    let enqueued = 0;
    for (const r of rows) {
      try {
        await backfillQueue.add(
          'backfill',
          {
            kind: 'entity-wikidata',
            userId: String(r.userId),
            entityKey: r.key as string,
          },
          {
            jobId: `backfill-entity__${String(r.userId)}__${r.key}`,
            attempts: 1,
            removeOnComplete: 500,
            removeOnFail: 500,
            priority: 100,
          },
        );
        enqueued += 1;
      } catch {
        // Same-jobId rejection = already queued; count as enqueued
        // so the response number reflects total work in flight.
      }
    }
    res.status(202).json({
      ok: true,
      candidateEntities: rows.length,
      enqueued,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/reset/scopes', requireAdmin, (_req, res) => {
  res.json({
    scopes: SCOPES.map((s) => ({
      id: s.id,
      group: s.group,
      label: s.label,
      description: s.description,
    })),
  });
});

/**
 * Run the requested scopes. The body must include `confirm: 'RESET'`
 * (case-sensitive) AND a non-empty `scopes` array.
 *
 * Each scope runs sequentially; partial failures don't roll back —
 * the response carries per-scope counts and any errors so the
 * admin sees what landed and what didn't.
 */
adminRouter.post('/reset', requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as {
    confirm?: string;
    scopes?: string[];
  };
  if (body.confirm !== 'RESET') {
    res.status(400).json({
      error: 'confirmation_required',
      message: 'Pass confirm=RESET in the request body to proceed.',
    });
    return;
  }
  const requested = Array.isArray(body.scopes) ? body.scopes : [];
  if (requested.length === 0) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Pass a non-empty `scopes` array.',
    });
    return;
  }

  // Honour the catalog's order rather than the request's, so
  // dependent scopes (PageRevision before Page, Message before
  // Conversation) clear in the right sequence.
  const ordered = SCOPES.filter((s) => requested.includes(s.id));
  const unknown = requested.filter((id) => !SCOPE_BY_ID.has(id));
  if (unknown.length > 0) {
    res.status(400).json({
      error: 'invalid_request',
      message: `Unknown scope(s): ${unknown.join(', ')}`,
    });
    return;
  }

  const results: Array<{ id: string; deleted: number; ok: boolean; error?: string }> = [];
  for (const scope of ordered) {
    try {
      const { deleted } = await scope.run();
      results.push({ id: scope.id, deleted, ok: true });
      logger.warn(
        { scope: scope.id, deleted },
        'admin reset: scope cleared',
      );
    } catch (err) {
      results.push({
        id: scope.id,
        deleted: 0,
        ok: false,
        error: (err as Error).message ?? 'unknown error',
      });
      logger.error(
        { err, scope: scope.id },
        'admin reset: scope failed',
      );
    }
  }

  res.json({
    ok: results.every((r) => r.ok),
    results,
  });
});
