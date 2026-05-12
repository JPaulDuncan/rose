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
