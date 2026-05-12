import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Product,
  ProductPurchase,
  Page,
  SenderBrand,
  normalizeTagKey,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const productsRouter: Router = Router();

/**
 * Per-user product directory. Joins ProductPurchase rows up to
 * their global Product to surface "stuff this user has bought,"
 * sorted by recency. Aggregates spend + count so the list view
 * doesn't need a follow-up call.
 */
productsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const since = req.query.since
    ? new Date(req.query.since as string)
    : null;
  const filter: Record<string, unknown> = { userId };
  if (since && !Number.isNaN(since.getTime())) {
    filter.purchasedAt = { $gte: since };
  }
  const rows = await ProductPurchase.aggregate<{
    _id: Types.ObjectId;
    purchaseCount: number;
    totalAmount: number | null;
    currency: string | null;
    firstPurchasedAt: Date | null;
    lastPurchasedAt: Date | null;
  }>([
    { $match: filter },
    {
      $group: {
        _id: '$productId',
        purchaseCount: { $sum: 1 },
        totalAmount: { $sum: { $ifNull: ['$amount', 0] } },
        currency: { $first: '$currency' },
        firstPurchasedAt: { $min: '$purchasedAt' },
        lastPurchasedAt: { $max: '$purchasedAt' },
      },
    },
    { $sort: { lastPurchasedAt: -1, purchaseCount: -1 } },
    { $limit: 500 },
  ]);
  const productIds = rows.map((r) => r._id);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
        .select('slugKey name manufacturer modelNumber category imageUrl')
        .lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  res.json({
    products: rows.map((r) => {
      const meta = byId.get(String(r._id));
      return {
        productId: String(r._id),
        slugKey: meta?.slugKey ?? '',
        name: meta?.name ?? '(unknown)',
        manufacturer: meta?.manufacturer ?? null,
        modelNumber: meta?.modelNumber ?? null,
        category: meta?.category ?? null,
        imageUrl: meta?.imageUrl ?? null,
        purchaseCount: r.purchaseCount,
        totalAmount: r.totalAmount,
        currency: r.currency,
        firstPurchasedAt: r.firstPurchasedAt
          ? new Date(r.firstPurchasedAt).toISOString()
          : null,
        lastPurchasedAt: r.lastPurchasedAt
          ? new Date(r.lastPurchasedAt).toISOString()
          : null,
      };
    }),
  });
});

/**
 * Spending rollup — totals per coarse category. Drives a
 * "where my money went last month" widget on the products list
 * and the future spending dashboard.
 */
productsRouter.get('/spend', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sinceQ = req.query.since as string | undefined;
  const since = sinceQ ? new Date(sinceQ) : null;
  const match: Record<string, unknown> = { userId };
  if (since && !Number.isNaN(since.getTime())) {
    match.purchasedAt = { $gte: since };
  }
  const rows = await ProductPurchase.aggregate<{
    _id: { category: string | null; currency: string | null };
    total: number;
    count: number;
  }>([
    { $match: match },
    {
      $lookup: {
        from: 'products',
        localField: 'productId',
        foreignField: '_id',
        as: 'product',
      },
    },
    { $unwind: '$product' },
    {
      $group: {
        _id: { category: '$product.category', currency: '$currency' },
        total: { $sum: { $ifNull: ['$amount', 0] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
  ]);
  res.json({
    byCategory: rows.map((r) => ({
      category: r._id.category ?? 'uncategorized',
      currency: r._id.currency ?? null,
      total: r.total,
      count: r.count,
    })),
  });
});

/**
 * Product detail — canonical info merged with this user's
 * purchase history. Receipts link back to their source pages so
 * the user can drill into the original email/article.
 */
productsRouter.get('/:slug', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const slugKey = normalizeTagKey(decodeURIComponent(req.params.slug ?? ''));
  if (!slugKey) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const product = await Product.findOne({ slugKey }).lean();
  if (!product) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const purchases = await ProductPurchase.find({
    userId,
    productId: product._id,
  })
    .sort({ purchasedAt: -1, createdAt: -1 })
    .lean();
  if (purchases.length === 0) {
    // The Product is global; this user has nothing to show. 404 so
    // they don't see a stranger's product page they didn't buy.
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Resolve merchants for the brand chips. Pull SenderBrand for
  // every distinct merchantBrandKey in this user's purchase list.
  const brandKeys = [
    ...new Set(
      purchases
        .map((p) => p.merchantBrandKey as string | null)
        .filter((k): k is string => !!k),
    ),
  ];
  const brands = brandKeys.length
    ? await SenderBrand.find({ brandKey: { $in: brandKeys } })
        .select('brandKey name logoUrl')
        .lean()
    : [];
  const brandByKey = new Map(brands.map((b) => [b.brandKey, b]));

  // Source pages for the inline receipt links.
  const pageIds = [...new Set(purchases.map((p) => p.pageId))];
  const pages = pageIds.length
    ? await Page.find({ _id: { $in: pageIds }, userId })
        .select('_id slug title updatedAt')
        .lean()
    : [];
  const pageById = new Map(pages.map((p) => [String(p._id), p]));

  // Spend summary.
  let total = 0;
  let count = 0;
  for (const p of purchases) {
    total += (p.amount as number | null) ?? 0;
    count += (p.quantity as number | undefined) ?? 1;
  }
  const currency = (purchases[0]?.currency as string | null) ?? null;

  res.json({
    product: {
      _id: String(product._id),
      slugKey: product.slugKey,
      name: product.name,
      manufacturer: product.manufacturer,
      modelNumber: product.modelNumber,
      category: product.category,
      summary: product.summary,
      imageUrl: product.imageUrl,
      wikidataId: (product.wikidataId as string | null | undefined) ?? null,
      wikidataConfidence:
        (product.wikidataConfidence as number | undefined) ?? 0,
    },
    summary: {
      totalAmount: total,
      currency,
      purchaseCount: purchases.length,
      totalQuantity: count,
      firstPurchasedAt: purchases[purchases.length - 1]?.purchasedAt
        ? new Date(
            purchases[purchases.length - 1]!.purchasedAt as Date,
          ).toISOString()
        : null,
      lastPurchasedAt: purchases[0]?.purchasedAt
        ? new Date(purchases[0]!.purchasedAt as Date).toISOString()
        : null,
    },
    purchases: purchases.map((p) => {
      const brand = p.merchantBrandKey
        ? brandByKey.get(p.merchantBrandKey as string)
        : null;
      const page = pageById.get(String(p.pageId));
      return {
        _id: String(p._id),
        amount: p.amount,
        currency: p.currency,
        quantity: p.quantity,
        purchasedAt: p.purchasedAt
          ? new Date(p.purchasedAt as Date).toISOString()
          : null,
        // 'structured' = read straight from the email's schema.org
        // JSON-LD/Microdata; 'llm' = inferred from prose. The UI
        // surfaces this so the user knows which rows have higher
        // fidelity. Defaults to 'llm' for rows extracted before
        // the structured fast-path landed.
        extractedBy:
          (p.extractedBy as 'structured' | 'llm' | undefined) ?? 'llm',
        merchant: brand
          ? { brandKey: brand.brandKey, name: brand.name, logoUrl: brand.logoUrl ?? null }
          : null,
        page: page
          ? { slug: page.slug, title: page.title }
          : null,
      };
    }),
  });
});

/**
 * Remove a single purchase row. Used when the LLM mis-parsed an
 * item and the user wants to clean it up. Leaves the global
 * Product row alone — other users might still reference it.
 */
productsRouter.delete('/purchases/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await ProductPurchase.deleteOne({ _id: id, userId });
  res.json({ ok: true });
});
