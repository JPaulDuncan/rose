import { Router } from 'express';
import {
  ApiToken,
  BayesProfile,
  CalendarEvent,
  Category,
  Conversation,
  DaydreamNote,
  Email,
  Entity,
  LibraryDocument,
  LibrarySource,
  Message,
  NotificationRule,
  OutboundMessage,
  Page,
  PageRevision,
  PushSubscription,
  Rule,
  RuleAuditLog,
  Sender,
  SenderBrand,
  ShareLink,
  Source,
  TagCanonical,
  TagDigest,
  User,
  UserPageState,
  WebhookSubscription,
} from '@rose/db';
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
      'Personal document store contents. The library sources stay; documents get re-ingested on next sync.',
    run: () => deleteAllAndReport(LibraryDocument),
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
      'Per-user tag synonym registry. Page tags stay; the canonicalisation table rebuilds on next page write.',
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
      'Embedded in every User document. Clears `savedSearches[]`, `featuredTags[]`, and `weatherLocation` for every user.',
    run: async () => {
      const r = await User.updateMany(
        {},
        {
          $set: {
            savedSearches: [],
            featuredTags: [],
            weatherLocation: null,
          },
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
