import { Types } from 'mongoose';
import {
  Product,
  ProductPurchase,
  normalizeTagKey,
  type PageDoc,
} from '@rose/db';
import { ReceiptExtraction } from '@rose/shared';
import { SYSTEM_PROMPT_BASE, extractJson } from '@rose/llm';
import { senderDomainTag } from '@rose/email-parser';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Pages that should run through the receipt extractor. Heuristic
 * by tag — the canonicalizer already collapses "receipts" /
 * "invoice" / "order-confirmation" under one of these — plus an
 * escape hatch for sender-driven detection if we later want one.
 *
 * Tag matching is intentionally generous: a receipt page can land
 * with `#receipt`, `#receipts`, `#invoice`, `#order` and still
 * trigger extraction.
 */
const RECEIPT_TAGS = new Set([
  'receipt',
  'receipts',
  'invoice',
  'invoices',
  'order',
  'order-confirmation',
  'purchase',
]);

export function isReceiptPage(page: PageDoc): boolean {
  const tags = ((page.tags as string[] | undefined) ?? []).map((t) =>
    t.toLowerCase(),
  );
  const topics = ((page.topics as string[] | undefined) ?? []).map((t) =>
    t.toLowerCase(),
  );
  return [...tags, ...topics].some((t) => RECEIPT_TAGS.has(t));
}

const RECEIPT_SYSTEM_PROMPT = `You extract structured purchase data from a receipt or order
confirmation. Given the receipt body, identify each product or line
item purchased. Return ONLY valid JSON matching the schema below.
Do not invent items. If a field is unclear, use null.

Schema:
{
  "merchant": "<merchant or brand name>" | null,
  "purchasedAt": "<ISO date YYYY-MM-DD if present>" | null,
  "currency": "<ISO 4217 uppercase, e.g. USD>" | null,
  "totalAmount": <number> | null,
  "products": [
    {
      "name": "<canonical product name, no quantity prefix>",
      "modelNumber": "<SKU/model>" | null,
      "manufacturer": "<brand>" | null,
      "category": "food" | "electronics" | "clothing" | "home" | "media" | "service" | "travel" | "health" | "office" | "other" | null,
      "amount": <line-item amount as a number> | null,
      "quantity": <integer, default 1>
    }
  ]
}

Skip shipping, tax, and fee line items unless they're a standalone
product. Always lowercase the currency code on output.`;

function renderPrompt(page: PageDoc): string {
  const title = page.title ?? '';
  const summary = page.summary ?? '';
  const body = (page.contentMd ?? '').slice(0, 6000);
  return [
    `TITLE: ${title}`,
    `SUMMARY: ${summary}`,
    '',
    'BODY:',
    body,
  ].join('\n');
}

/**
 * Parse a free-text date the LLM emits ("Dec 12, 2024", "2024-12-12",
 * etc.) into a `Date`. Returns null when nothing usable is in the
 * string — the worker falls back to the page's articleDate so the
 * purchase row always has a usable timestamp downstream.
 */
function parsePurchasedAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return new Date(ts);
  return null;
}

/**
 * Upsert the canonical Product row, returning its id. First
 * extraction wins the name + manufacturer + category via
 * $setOnInsert; later calls only $set imageUrl when a non-null
 * value is provided. Mirrors the pattern used by Organization /
 * SenderBrand.
 */
async function upsertProduct(
  userId: Types.ObjectId,
  p: {
    name: string;
    modelNumber: string | null;
    manufacturer: string | null;
    category: string | null;
  },
): Promise<Types.ObjectId | null> {
  // Build the slug from name + modelNumber so two `iPhone 15`
  // entries with different SKUs don't collapse, but plain
  // "MacBook Pro" without a model number stays a single row.
  const base = [p.name, p.modelNumber].filter(Boolean).join(' ');
  const slugKey = normalizeTagKey(base);
  if (!slugKey) return null;
  const setOnInsert: Record<string, unknown> = {
    slugKey,
    name: p.name.slice(0, 200),
    firstSeenBy: userId,
  };
  if (p.manufacturer) setOnInsert.manufacturer = p.manufacturer;
  if (p.modelNumber) setOnInsert.modelNumber = p.modelNumber;
  if (p.category) setOnInsert.category = p.category;
  const row = await Product.findOneAndUpdate(
    { slugKey },
    { $setOnInsert: setOnInsert },
    { upsert: true, new: true },
  );
  return row?._id ?? null;
}

/**
 * Run the receipt extractor for one Page. Idempotent via the
 * unique `(userId, productId, pageId)` index on ProductPurchase —
 * regenerating the page or re-running this extractor produces no
 * duplicates. Best-effort: any LLM / network failure logs and
 * returns 0 so receipts don't block page persistence.
 */
export async function extractReceiptFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<{ products: number; purchases: number }> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 40) return { products: 0, purchases: 0 };

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.debug({ err }, 'extract-receipt: provider unavailable');
    return { products: 0, purchases: 0 };
  }

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt: renderPrompt(page),
      system: `${SYSTEM_PROMPT_BASE}\n\n${RECEIPT_SYSTEM_PROMPT}`,
      format: 'json',
      temperature: 0.1,
      maxTokens: 1200,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-receipt: generate failed',
    );
    return { products: 0, purchases: 0 };
  }

  let parsed: ReceiptExtraction;
  try {
    parsed = ReceiptExtraction.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-receipt: invalid JSON',
    );
    return { products: 0, purchases: 0 };
  }

  // Resolve the merchant. Prefer the LLM's verbatim merchant name
  // but fall back to the page's sender brand for the brand chip.
  const senderAddresses = (page.senderAddresses as string[] | undefined) ?? [];
  const merchantBrandKey =
    senderAddresses
      .map((a) => senderDomainTag(a)?.toLowerCase() ?? null)
      .filter((b): b is string => !!b)[0] ?? null;

  const purchasedAt =
    parsePurchasedAt(parsed.purchasedAt) ??
    (page.articleDate ? new Date(page.articleDate as Date) : null);
  const currency = parsed.currency ? parsed.currency.toUpperCase() : null;

  let productCount = 0;
  let purchaseCount = 0;
  for (const item of parsed.products) {
    if (!item.name?.trim()) continue;
    const productId = await upsertProduct(userId, {
      name: item.name,
      modelNumber: item.modelNumber,
      manufacturer: item.manufacturer,
      category: item.category,
    });
    if (!productId) continue;
    productCount += 1;

    // Per-user purchase row. setOnInsert preserves the original
    // capture time across re-extractions; $set keeps amount /
    // currency / purchasedAt fresh in case the LLM revises them
    // on a regen.
    await ProductPurchase.updateOne(
      { userId, productId, pageId: page._id as Types.ObjectId },
      {
        $setOnInsert: {
          userId,
          productId,
          pageId: page._id,
          emailId:
            (page.sourceEmailIds as Types.ObjectId[] | undefined)?.[0] ??
            null,
        },
        $set: {
          merchantBrandKey,
          amount: item.amount,
          currency,
          quantity: item.quantity ?? 1,
          purchasedAt,
        },
      },
      { upsert: true },
    );
    purchaseCount += 1;
  }
  return { products: productCount, purchases: purchaseCount };
}

/**
 * Convenience wrapper used by the post-write hooks worker. Gates
 * on `isReceiptPage` so non-receipt pages skip the LLM call.
 */
export async function runPostWriteReceiptExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  if (!isReceiptPage(page)) return;
  try {
    const r = await extractReceiptFromPage(userId, page);
    if (r.purchases > 0) {
      logger.info(
        { pageId: String(page._id), ...r },
        'extract-receipt: linked purchases',
      );
    }
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'post-write receipt extraction failed; continuing',
    );
  }
}
