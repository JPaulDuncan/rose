import { Router } from 'express';
import { Types } from 'mongoose';
import { Subscription, SenderBrand, Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const subscriptionsRouter: Router = Router();

/**
 * List the user's subscriptions, newest-renewing first. Drives the
 * /subscriptions page + a future "monthly recurring spend" widget.
 * Filters:
 *   ?status=active|cancelled|expired  default: all
 *   ?category=<key>                   single-category filter
 */
subscriptionsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const status = (req.query.status as string | undefined) ?? undefined;
  const category = (req.query.category as string | undefined) ?? undefined;
  const filter: Record<string, unknown> = { userId };
  if (status && ['active', 'cancelled', 'expired'].includes(status)) {
    filter.status = status;
  }
  if (category) filter.category = category;
  const subs = await Subscription.find(filter)
    .sort({ nextRenewalAt: 1, serviceName: 1 })
    .lean();

  // Resolve merchant brand chips. Pull SenderBrand for every
  // distinct brandKey in one round trip.
  const brandKeys = [
    ...new Set(
      subs
        .map((s) => s.brandKey as string | null)
        .filter((b): b is string => !!b),
    ),
  ];
  const brands = brandKeys.length
    ? await SenderBrand.find({ brandKey: { $in: brandKeys } })
        .select('brandKey name logoUrl')
        .lean()
    : [];
  const brandByKey = new Map(brands.map((b) => [b.brandKey, b]));

  res.json({
    subscriptions: subs.map((s) => {
      const brand = s.brandKey ? brandByKey.get(s.brandKey as string) : null;
      return {
        _id: String(s._id),
        serviceName: s.serviceName,
        serviceKey: s.serviceKey,
        brandKey: s.brandKey,
        merchant: brand
          ? {
              name: brand.name,
              logoUrl: (brand.logoUrl as string | null) ?? null,
            }
          : null,
        amount: s.amount,
        currency: s.currency,
        cadence: s.cadence,
        category: s.category,
        nextRenewalAt: s.nextRenewalAt
          ? new Date(s.nextRenewalAt as Date).toISOString()
          : null,
        status: s.status,
        firstSeenAt: s.firstSeenAt
          ? new Date(s.firstSeenAt as Date).toISOString()
          : null,
        updatedAt: s.updatedAt
          ? new Date(s.updatedAt as Date).toISOString()
          : null,
      };
    }),
  });
});

/**
 * Estimated monthly recurring spend, with everything normalised to
 * a monthly cadence:
 *   yearly      → / 12
 *   quarterly   → / 3
 *   weekly      → × 52/12 ≈ × 4.345
 *   other / null → excluded
 *
 * Active subscriptions only (cancelled / expired contribute 0).
 * Grouped by currency since mixing currencies in a sum is
 * meaningless without an FX layer (out of scope).
 */
subscriptionsRouter.get('/monthly-spend', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const subs = await Subscription.find({
    userId,
    status: 'active',
    amount: { $ne: null },
  })
    .select('amount currency cadence')
    .lean();
  const totals = new Map<string, number>();
  for (const s of subs) {
    const amount = (s.amount as number | null) ?? 0;
    const currency = (s.currency as string | null) ?? 'unknown';
    let monthly: number;
    switch (s.cadence as string) {
      case 'yearly':
        monthly = amount / 12;
        break;
      case 'quarterly':
        monthly = amount / 3;
        break;
      case 'monthly':
        monthly = amount;
        break;
      case 'weekly':
        monthly = (amount * 52) / 12;
        break;
      default:
        continue;
    }
    totals.set(currency, (totals.get(currency) ?? 0) + monthly);
  }
  res.json({
    byCurrency: [...totals.entries()].map(([currency, total]) => ({
      currency,
      monthly: Math.round(total * 100) / 100,
    })),
  });
});

/**
 * Detail for one subscription — adds the evidence pages so the
 * audit panel can show "Rose learned about this from <list>".
 */
subscriptionsRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const sub = await Subscription.findOne({ _id: req.params.id, userId }).lean();
  if (!sub) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Hydrate evidence pageIds to slugs so the UI can link.
  const evidence = (sub.evidence as Array<{
    pageId: Types.ObjectId | null;
    emailId: Types.ObjectId | null;
    snippet: string;
    extractedAt: Date;
  }> | undefined) ?? [];
  const pageIds = [
    ...new Set(
      evidence
        .map((e) => (e.pageId ? String(e.pageId) : null))
        .filter((p): p is string => !!p),
    ),
  ];
  const pages = pageIds.length
    ? await Page.find({ userId, _id: { $in: pageIds } })
        .select('_id slug title')
        .lean()
    : [];
  const pageById = new Map(pages.map((p) => [String(p._id), p]));
  res.json({
    subscription: {
      _id: String(sub._id),
      serviceName: sub.serviceName,
      brandKey: sub.brandKey,
      amount: sub.amount,
      currency: sub.currency,
      cadence: sub.cadence,
      category: sub.category,
      nextRenewalAt: sub.nextRenewalAt
        ? new Date(sub.nextRenewalAt as Date).toISOString()
        : null,
      status: sub.status,
      evidence: evidence.map((e) => {
        const page = e.pageId ? pageById.get(String(e.pageId)) : null;
        return {
          pageId: e.pageId ? String(e.pageId) : null,
          pageSlug: page?.slug ?? null,
          pageTitle: page?.title ?? null,
          extractedAt: e.extractedAt
            ? new Date(e.extractedAt).toISOString()
            : null,
        };
      }),
    },
  });
});

/**
 * Manually delete a subscription row — used to clean up an
 * LLM-misextracted entry. Does NOT remove the source page;
 * regenerating that page would re-extract.
 */
subscriptionsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await Subscription.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
