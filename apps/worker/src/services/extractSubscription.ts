import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { Subscription, type PageDoc } from '@rose/db';
import { SubscriptionExtraction } from '@rose/shared';
import { SYSTEM_PROMPT_BASE, extractJson } from '@rose/llm';
import { senderDomainTag } from '@rose/email-parser';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Subscription extractor. Gated by a cheap tag / keyword check so
 * we don't pay for an LLM call on every page — only on pages that
 * look like subscription notices (renewals, sign-ups, cancellations).
 *
 * Idempotent: `subscriptionExtractedFromHash` on Page short-circuits
 * a re-extraction when contentMd hasn't changed. The Subscription
 * row dedupes on `(userId, serviceKey)` — re-extracting an updated
 * notice for the same service refreshes amount / cadence /
 * nextRenewalAt / status and appends an evidence entry.
 */

const SUBSCRIPTION_TAGS = new Set([
  'subscription',
  'subscriptions',
  'renewal',
  'renewals',
  'auto-renewal',
  'auto-renew',
  'recurring',
  'membership',
  'memberships',
]);

const SUBSCRIPTION_BODY_HINTS = [
  /your subscription/i,
  /will (auto[- ]?)?renew/i,
  /monthly (plan|charge|subscription)/i,
  /yearly (plan|charge|subscription)/i,
  /annual (plan|charge|subscription)/i,
  /membership (renews|renewed|renewal)/i,
  /thank you for subscribing/i,
  /your trial ends/i,
  /cancel(led)? your subscription/i,
];

export function isSubscriptionPage(page: PageDoc): boolean {
  const tags = ((page.tags as string[] | undefined) ?? []).map((t) =>
    t.toLowerCase(),
  );
  const topics = ((page.topics as string[] | undefined) ?? []).map((t) =>
    t.toLowerCase(),
  );
  if ([...tags, ...topics].some((t) => SUBSCRIPTION_TAGS.has(t))) return true;
  const body = (page.contentMd ?? '').slice(0, 4000);
  return SUBSCRIPTION_BODY_HINTS.some((re) => re.test(body));
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

const SYSTEM_PROMPT = `You extract subscription details from a single email or its rendered
wiki page. Identify the single recurring service (if any) that this
notice is about — renewal, sign-up, cancellation, trial-ending,
billing.

Return ONLY JSON. Two valid shapes:

  { "skip": true }
    → this isn't about a recurring subscription, or you can't
      identify one cleanly.

  { "skip": false,
    "serviceName": "<the service as written, e.g. 'Netflix'>",
    "amount": <recurring charge as a number, or null>,
    "currency": "<ISO 4217 uppercase>" | null,
    "cadence": "monthly" | "yearly" | "quarterly" | "weekly" | "other",
    "nextRenewalAt": "<ISO YYYY-MM-DD if stated>" | null,
    "status": "active" | "cancelled" | "expired",
    "category": "media" | "software" | "utility" | "fitness" |
                "news" | "insurance" | "cloud" | "other" | null }

Rules:
  • One service per email. Skip line items that aren't the focus.
  • Don't invent amounts. If only the cadence is mentioned and not
    the price, leave amount null.
  • 'status' = 'cancelled' when the user has cancelled but coverage
    may continue; 'expired' = already lapsed; 'active' = recurring.`;

function renderPrompt(page: PageDoc): string {
  const title = page.title ?? '';
  const summary = page.summary ?? '';
  const body = (page.contentMd ?? '').slice(0, 6000);
  return [`TITLE: ${title}`, `SUMMARY: ${summary}`, '', 'BODY:', body].join('\n');
}

function parseRenewalDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

export async function extractSubscriptionFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<boolean> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 40) return false;
  const hash = hashBody(body);
  const cachedHash = (
    page as unknown as { subscriptionExtractedFromHash?: string }
  ).subscriptionExtractedFromHash;
  if (cachedHash === hash) return false;

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.debug({ err }, 'extract-subscription: provider unavailable');
    return false;
  }

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt: renderPrompt(page),
      system: `${SYSTEM_PROMPT_BASE}\n\n${SYSTEM_PROMPT}`,
      format: 'json',
      temperature: 0.1,
      maxTokens: 600,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-subscription: generate failed',
    );
    return false;
  }

  let parsed: SubscriptionExtraction;
  try {
    parsed = SubscriptionExtraction.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-subscription: invalid JSON',
    );
    return false;
  }

  // Stamp the hash so a regen with identical body short-circuits.
  try {
    (
      page as unknown as { subscriptionExtractedFromHash?: string }
    ).subscriptionExtractedFromHash = hash;
    page.markModified?.('subscriptionExtractedFromHash');
    await page.save?.();
  } catch (err) {
    logger.debug({ err }, 'extract-subscription: hash stamp failed (ignored)');
  }

  if (parsed.skip) return false;

  const serviceName = parsed.serviceName.trim();
  const serviceKey = serviceName.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!serviceKey) return false;

  // Resolve merchant brand-key from the page's senderAddresses for
  // the brand chip on the row.
  const senderAddresses = (page.senderAddresses as string[] | undefined) ?? [];
  const brandKey =
    senderAddresses
      .map((a) => senderDomainTag(a)?.toLowerCase() ?? null)
      .filter((b): b is string => !!b)[0] ?? null;

  const nextRenewalAt = parseRenewalDate(parsed.nextRenewalAt);
  const currency = parsed.currency ? parsed.currency.toUpperCase() : null;
  const emailId =
    (page.sourceEmailIds as Types.ObjectId[] | undefined)?.[0] ?? null;

  const evidenceEntry = {
    pageId: page._id as Types.ObjectId,
    emailId,
    snippet: '',
    extractedAt: new Date(),
  };

  // Idempotent upsert. setOnInsert preserves the user's first
  // capture time across re-extractions; $set keeps the dynamic
  // fields fresh; $push to evidence with $slice bounds growth.
  await Subscription.updateOne(
    { userId, serviceKey },
    {
      $setOnInsert: {
        userId,
        serviceKey,
        serviceName,
        firstSeenAt: new Date(),
      },
      $set: {
        serviceName,
        brandKey,
        amount: parsed.amount,
        currency,
        cadence: parsed.cadence,
        nextRenewalAt,
        status: parsed.status,
        category: parsed.category,
      },
    },
    { upsert: true },
  );
  // Push evidence and cap at 20 entries — re-pushing the same
  // (pageId, emailId) pair is fine; the audit shows every time
  // this email was re-processed.
  await Subscription.updateOne(
    { userId, serviceKey },
    {
      $push: {
        evidence: { $each: [evidenceEntry], $slice: -20 },
      },
    },
  );
  logger.info(
    { pageId: String(page._id), serviceKey, status: parsed.status },
    'extract-subscription: stored',
  );
  return true;
}

export async function runPostWriteSubscriptionExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  if (!isSubscriptionPage(page)) return;
  try {
    await extractSubscriptionFromPage(userId, page);
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'post-write subscription extraction failed; continuing',
    );
  }
}
