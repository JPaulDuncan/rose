import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Sender } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const promotionsRouter: Router = Router();

/**
 * Promotional pages that the digest hides by default. Returns a flat
 * list of cards plus a `senderBrands` index so the client can render
 * brand chips / logos without a follow-up fetch.
 */
promotionsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 60), 200);
  const filter = {
    userId,
    'flags.isPromotional': true,
    'flags.userMarkedSpam': { $ne: true },
    'flags.autoQuarantined': { $ne: true },
  };
  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select(
      'slug title summary heroImageUrl tags topics senderAddresses sourceEmailIds updatedAt flags',
    )
    .lean();
  const total = await Page.countDocuments(filter);

  // Brand index — same shape as the digest payload.
  const allAddrs = [
    ...new Set(
      pages.flatMap((p) => (p.senderAddresses as string[] | undefined) ?? []),
    ),
  ];
  const senders = allAddrs.length
    ? await Sender.find({ userId, addresses: { $in: allAddrs } })
        .select('brandKey name domain logoUrl addresses')
        .lean()
    : [];
  const senderBrands: Record<
    string,
    { brandKey: string; name: string; domain: string | null; logoUrl: string | null }
  > = {};
  for (const s of senders) {
    for (const a of s.addresses ?? []) {
      senderBrands[a] = {
        brandKey: s.brandKey,
        name: s.name,
        domain: s.domain ?? null,
        logoUrl: s.logoUrl ?? null,
      };
    }
  }

  res.json({
    pages: pages.map((p) => ({
      _id: String(p._id),
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      heroImageUrl: p.heroImageUrl ?? null,
      tags: p.tags ?? [],
      topics: p.topics ?? [],
      senderAddresses: p.senderAddresses ?? [],
      messageCount: (p.sourceEmailIds ?? []).length,
      updatedAt: p.updatedAt,
    })),
    total,
    senderBrands,
  });
});
