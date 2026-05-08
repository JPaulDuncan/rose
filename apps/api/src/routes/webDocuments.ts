import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User, WebDocument } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { logger } from '../lib/logger.js';

/**
 * Web-research artefact endpoints (web-integration Phase 3).
 *
 * Surfaces the WebDocument cache to the user via the new
 * Codex → Web sources tab. Two motivating uses:
 *
 *   1. Transparency — what HAS Rose been reading on my behalf?
 *      Grouped by hostKey for an at-a-glance "did the budget go
 *      where I expected" answer.
 *   2. Control — "stop pulling from this hostname." A one-click
 *      add to settings.daydream.webResearch.denyHosts that
 *      propagates to every future research run.
 *
 * Read access is per-user, scoped through the standard requireAuth
 * middleware. No write paths beyond the denyHost append + per-doc
 * delete; the orchestrator owns canonical creation.
 */

export const webDocumentsRouter: Router = Router();

/**
 * GET /api/web-documents
 *
 * Returns the user's WebDocument cache grouped by hostKey, plus
 * the per-host fetch count + most-recent-fetched timestamp + the
 * top-3 most-relevant docs. Capped at the most-recent N hosts so
 * a heavy crawler on a small mailbox doesn't ship megabytes of
 * URLs to the SPA.
 *
 * Off-topic + robots-blocked rows are surfaced too (they're useful
 * "we tried, didn't keep" signal); the UI presents them visually
 * de-emphasised.
 */
webDocumentsRouter.get('/', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));

    // Aggregation: group by hostKey, count, max(fetchedAt), and
    // pull the top-3-by-relevance per host as a sample. Capped at
    // 100 hosts.
    const grouped = await WebDocument.aggregate<{
      _id: string;
      hostKey: string;
      docCount: number;
      onTopicCount: number;
      offTopicCount: number;
      robotsBlockedCount: number;
      lastFetchedAt: Date;
      avgRelevance: number;
      sample: {
        _id: Types.ObjectId;
        title: string;
        url: string;
        relevanceScore: number;
        offTopic: boolean;
        robotsAllowed: boolean;
        fetchedAt: Date;
        topicLabel: string;
        triggeringPageId: Types.ObjectId | null;
        fetchDepth: number;
        discoveredVia: string;
      }[];
    }>([
      { $match: { userId } },
      {
        $group: {
          _id: '$hostKey',
          hostKey: { $first: '$hostKey' },
          docCount: { $sum: 1 },
          onTopicCount: {
            $sum: {
              $cond: [{ $and: [{ $not: '$offTopic' }, '$robotsAllowed'] }, 1, 0],
            },
          },
          offTopicCount: { $sum: { $cond: ['$offTopic', 1, 0] } },
          robotsBlockedCount: {
            $sum: { $cond: [{ $not: '$robotsAllowed' }, 1, 0] },
          },
          lastFetchedAt: { $max: '$fetchedAt' },
          avgRelevance: { $avg: '$relevanceScore' },
          // $push every doc and slice client-side. With caps in
          // place upstream (synthesis cap = 12 per run) the per-host
          // count is small enough that this is fine.
          sample: {
            $push: {
              _id: '$_id',
              title: '$title',
              url: '$url',
              relevanceScore: '$relevanceScore',
              offTopic: '$offTopic',
              robotsAllowed: '$robotsAllowed',
              fetchedAt: '$fetchedAt',
              topicLabel: '$topicLabel',
              triggeringPageId: '$triggeringPageId',
              fetchDepth: '$fetchDepth',
              discoveredVia: '$discoveredVia',
            },
          },
        },
      },
      { $sort: { lastFetchedAt: -1 } },
      { $limit: 100 },
    ]);

    // Slice each host's sample to the top 6 by relevance (most-on-
    // topic first), trimming the rest out before serialisation so
    // the payload stays bounded.
    const hosts = grouped.map((g) => ({
      hostKey: g.hostKey,
      docCount: g.docCount,
      onTopicCount: g.onTopicCount,
      offTopicCount: g.offTopicCount,
      robotsBlockedCount: g.robotsBlockedCount,
      lastFetchedAt: g.lastFetchedAt,
      avgRelevance: g.avgRelevance,
      sample: [...g.sample]
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 6)
        .map((s) => ({
          _id: String(s._id),
          title: s.title,
          url: s.url,
          relevanceScore: s.relevanceScore,
          offTopic: s.offTopic,
          robotsAllowed: s.robotsAllowed,
          fetchedAt: s.fetchedAt,
          topicLabel: s.topicLabel,
          triggeringPageId: s.triggeringPageId ? String(s.triggeringPageId) : null,
          fetchDepth: s.fetchDepth,
          discoveredVia: s.discoveredVia,
        })),
    }));

    // Also surface the user's current denyHosts so the UI can
    // render which hosts are already blocked.
    const user = (await User.findById(userId)
      .select('settings.daydream.webResearch.denyHosts')
      .lean()) as
      | { settings?: { daydream?: { webResearch?: { denyHosts?: string[] } } } }
      | null;
    const denyHosts = user?.settings?.daydream?.webResearch?.denyHosts ?? [];

    res.json({
      hosts,
      denyHosts,
      totals: {
        hostCount: hosts.length,
        docCount: hosts.reduce((s, h) => s + h.docCount, 0),
        onTopicCount: hosts.reduce((s, h) => s + h.onTopicCount, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/web-documents/forget-host
 *   body: { hostKey: string, deleteCached?: boolean }
 *
 * Adds `hostKey` to the user's denyHosts setting. Future research
 * runs skip URLs under that host at the frontier-seed step.
 *
 * If `deleteCached: true`, also evicts every WebDocument the user
 * has under the host. Defaults false — the cache is per-user and
 * TTL-evicts naturally; explicit deletion is the "I really don't
 * want this around" lever.
 */
const ForgetHostBody = z.object({
  hostKey: z.string().min(1).max(255),
  deleteCached: z.boolean().optional().default(false),
});
webDocumentsRouter.post(
  '/forget-host',
  validateBody(ForgetHostBody),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const body = req.body as z.infer<typeof ForgetHostBody>;
      const hostKey = body.hostKey.toLowerCase().trim();
      if (!hostKey) {
        res.status(400).json({ error: 'invalid_host' });
        return;
      }

      await User.updateOne(
        { _id: userId },
        { $addToSet: { 'settings.daydream.webResearch.denyHosts': hostKey } },
      );

      let deletedCount = 0;
      if (body.deleteCached) {
        const r = await WebDocument.deleteMany({ userId, hostKey });
        deletedCount = r.deletedCount ?? 0;
      }

      logger.info(
        { userId: String(userId), hostKey, deletedCount },
        'web-documents: host added to denyHosts',
      );
      res.json({ ok: true, hostKey, deletedCount });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/web-documents/unforget-host
 *
 * Removes a host from the denyHosts list. Doesn't restore previously-
 * deleted WebDocuments — the cache will rebuild on the next research
 * run that touches the host.
 */
const UnforgetHostBody = z.object({ hostKey: z.string().min(1).max(255) });
webDocumentsRouter.post(
  '/unforget-host',
  validateBody(UnforgetHostBody),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const hostKey = (req.body as z.infer<typeof UnforgetHostBody>).hostKey
        .toLowerCase()
        .trim();
      await User.updateOne(
        { _id: userId },
        { $pull: { 'settings.daydream.webResearch.denyHosts': hostKey } },
      );
      res.json({ ok: true, hostKey });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/web-documents/:id
 *   Per-document forget. Used when the user wants to drop a
 *   specific URL without forgetting the whole host.
 */
webDocumentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const idParam = String(req.params.id ?? '');
    if (!Types.ObjectId.isValid(idParam)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const r = await WebDocument.deleteOne({
      _id: new Types.ObjectId(idParam),
      userId,
    });
    res.json({ ok: true, deleted: (r.deletedCount ?? 0) > 0 });
  } catch (err) {
    next(err);
  }
});
