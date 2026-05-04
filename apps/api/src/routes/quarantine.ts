import { Router } from 'express';
import { Types } from 'mongoose';
import { Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const quarantineRouter: Router = Router();

/**
 * Pages the user should review:
 *   - `userMarkedSpam`: explicit spam mark
 *   - `autoQuarantined`: matched a sender that's accumulated enough
 *     spam-marks to trip the reputation threshold
 *   - `hasLikelySpam`: heuristic spam (subject patterns, auth fails…)
 *
 * The query exposes `kind=user|auto|heuristic|all` so the UI can show
 * just one bucket at a time. Defaults to `all`.
 */
quarantineRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const kind = (req.query.kind as string | undefined) ?? 'all';
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const ors: Record<string, unknown>[] = [];
  if (kind === 'all' || kind === 'user') ors.push({ 'flags.userMarkedSpam': true });
  if (kind === 'all' || kind === 'auto') ors.push({ 'flags.autoQuarantined': true });
  if (kind === 'all' || kind === 'heuristic')
    ors.push({
      'flags.hasLikelySpam': true,
      'flags.userMarkedSpam': { $ne: true },
      'flags.autoQuarantined': { $ne: true },
    });
  if (ors.length === 0) {
    res.json({ pages: [], counts: { user: 0, auto: 0, heuristic: 0 } });
    return;
  }

  const filter = { userId, $or: ors };
  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select(
      'slug title summary spamScore senderAddresses topics tags heroImageUrl flags updatedAt sourceEmailIds',
    )
    .lean();

  const [userCount, autoCount, heuristicCount] = await Promise.all([
    Page.countDocuments({ userId, 'flags.userMarkedSpam': true }),
    Page.countDocuments({ userId, 'flags.autoQuarantined': true }),
    Page.countDocuments({
      userId,
      'flags.hasLikelySpam': true,
      'flags.userMarkedSpam': { $ne: true },
      'flags.autoQuarantined': { $ne: true },
    }),
  ]);

  res.json({
    pages: pages.map((p) => ({
      _id: String(p._id),
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      spamScore: p.spamScore ?? 0,
      senderAddresses: p.senderAddresses ?? [],
      topics: p.topics ?? [],
      tags: p.tags ?? [],
      heroImageUrl: p.heroImageUrl ?? null,
      flags: p.flags ?? {},
      messageCount: (p.sourceEmailIds ?? []).length,
      updatedAt: p.updatedAt,
    })),
    counts: { user: userCount, auto: autoCount, heuristic: heuristicCount },
  });
});
