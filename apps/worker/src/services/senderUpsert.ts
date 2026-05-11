import { Types } from 'mongoose';
import { Queue } from 'bullmq';
import {
  Sender,
  SenderBrand,
  Entity,
  Organization,
  type EmailDoc,
  type PageDoc,
} from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { enrichOrganizationWikidata } from './wikidataResolver.js';

// One queue handle per process. The summarize-sender worker that
// consumes these is started by the worker bootstrap.
const summarizeQueue = new Queue('rose.summarize-sender', { connection: redis });

/**
 * Build a default logo URL for a brand-domain sender from
 * DuckDuckGo's public favicon service. Free, no key, returns a
 * usable image for ~all known brands; 404s harmlessly when the
 * domain has no favicon (the UI's <img onError> falls back to the
 * initial-letter avatar). We deliberately don't fetch the image —
 * the URL alone is enough; the user's browser pulls it on render.
 *
 * Skipped for personal-mail senders (brandKey contains '@'), since
 * we don't want to use Gmail/Yahoo's logo for an individual contact.
 */
function defaultLogoUrlForDomain(
  brandKey: string,
  domain: string | null,
): string | null {
  if (!domain) return null;
  if (brandKey.includes('@')) return null; // personal-mail address
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

/**
 * Brand key derivation. For brand domains we use the lowercase
 * second-level label so all `*@medium.com` and `notifications@email.medium.com`
 * collapse to "medium". For personal-mail providers (gmail/yahoo/…)
 * `senderDomainTag` returns null, and we fall back to the local part of
 * the address — each individual contact gets their own record there.
 */
export function brandKeyFor(addr: string | null | undefined): {
  brandKey: string;
  name: string;
  domain: string | null;
} | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const local = addr.slice(0, at).toLowerCase();
  const domain = addr.slice(at + 1).toLowerCase();
  const brand = senderDomainTag(addr);
  if (brand) {
    return { brandKey: brand.toLowerCase(), name: brand, domain };
  }
  // Personal-mail fallback. Use the local part as the key + the address
  // itself for the display name so the codex can list "alice@gmail.com"
  // distinctly from "bob@gmail.com".
  return { brandKey: `${local}@${domain}`, name: addr, domain };
}

/**
 * Take everything we just learned about a sender from one freshly-
 * generated page and merge it into the canonical Sender doc. Increments
 * counters, expands the addresses/websites lists, and (when the user
 * hasn't locked it) accepts a higher-confidence logo candidate.
 *
 * `pageWasNew` is true the first time a particular page is created.
 * Used to bump the per-sender pageCount accurately on regenerations
 * versus net-new pages.
 *
 * Plan 14 — also dual-writes brand-global fields to the shared
 * `SenderBrand` collection via `upsertGlobalSenderBrand` so every
 * user benefits from one user's email data (logo, addresses,
 * websites, name).
 */

type SenderBucket = {
  brandKey: string;
  domain: string | null;
  name: string;
  addresses: Set<string>;
  websites: Set<string>;
  unsubscribeUrls: Set<string>;
  logo: { url: string; alt: string | null; confidence: number } | null;
  emails: EmailDoc[];
};

/**
 * Upsert the global SenderBrand row for one bucket. Idempotent:
 * subsequent calls $addToSet new addresses / websites and only
 * overwrite the logo when the new candidate's confidence is
 * strictly higher than what's on file. Plan 14.
 */
async function upsertGlobalSenderBrand(
  userId: Types.ObjectId,
  b: SenderBucket,
): Promise<void> {
  const existing = await SenderBrand.findOne({ brandKey: b.brandKey })
    .select('logoUrl logoConfidence name')
    .lean();

  const candidateLogo = b.logo;
  const fallbackLogo = candidateLogo
    ? null
    : defaultLogoUrlForDomain(b.brandKey, b.domain);
  let nextLogoUrl = existing?.logoUrl ?? null;
  let nextLogoConfidence = existing?.logoConfidence ?? 0;
  if (
    candidateLogo &&
    candidateLogo.confidence > (existing?.logoConfidence ?? 0)
  ) {
    nextLogoUrl = candidateLogo.url;
    nextLogoConfidence = candidateLogo.confidence;
  } else if (!nextLogoUrl && fallbackLogo) {
    nextLogoUrl = fallbackLogo;
    nextLogoConfidence = 0.1;
  }

  // Keep `name` stable once set unless we still have the brand-key
  // default (matches the per-user Sender heuristic).
  const nextName =
    existing?.name && existing.name !== b.brandKey
      ? existing.name
      : b.name || b.brandKey;

  await SenderBrand.updateOne(
    { brandKey: b.brandKey },
    {
      $setOnInsert: {
        brandKey: b.brandKey,
        firstSeenBy: userId,
      },
      $set: {
        domain: b.domain,
        name: nextName,
        logoUrl: nextLogoUrl,
        logoConfidence: nextLogoConfidence,
      },
      $addToSet: {
        addresses: { $each: [...b.addresses] },
        websites: { $each: [...b.websites] },
        unsubscribeUrls: { $each: [...b.unsubscribeUrls].slice(0, 4) },
      },
    },
    { upsert: true },
  );
}

export async function upsertSendersFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
  emails: EmailDoc[],
  pageWasNew: boolean,
): Promise<void> {
  // Group emails by brand so each Sender doc is touched at most once.
  const buckets = new Map<
    string,
    {
      brandKey: string;
      name: string;
      domain: string | null;
      emails: EmailDoc[];
      addresses: Set<string>;
      websites: Set<string>;
      unsubscribeUrls: Set<string>;
      logo: { url: string; alt: string | null; confidence: number } | null;
    }
  >();

  for (const e of emails) {
    const addr = e.from?.address?.toLowerCase();
    const info = brandKeyFor(addr);
    if (!info || !addr) continue;
    let bucket = buckets.get(info.brandKey);
    if (!bucket) {
      bucket = {
        brandKey: info.brandKey,
        name: info.name,
        domain: info.domain,
        emails: [],
        addresses: new Set(),
        websites: new Set(),
        unsubscribeUrls: new Set(),
        logo: null,
      };
      buckets.set(info.brandKey, bucket);
    }
    bucket.emails.push(e);
    bucket.addresses.add(addr);
    for (const url of (e.unsubscribeUrls as string[] | undefined) ?? []) {
      bucket.unsubscribeUrls.add(url);
    }
    for (const link of (e.links as { url: string }[] | undefined) ?? []) {
      try {
        bucket.websites.add(new URL(link.url).hostname.toLowerCase());
      } catch {
        // skip malformed URL
      }
    }
    const logo = e.logoCandidate as
      | { url?: string | null; alt?: string | null; confidence?: number }
      | undefined;
    if (logo?.url && (logo.confidence ?? 0) > 0) {
      if (!bucket.logo || (logo.confidence ?? 0) > bucket.logo.confidence) {
        bucket.logo = {
          url: logo.url,
          alt: logo.alt ?? null,
          confidence: logo.confidence ?? 0,
        };
      }
    }
  }

  for (const b of buckets.values()) {
    // Plan 14 — populate the global SenderBrand row alongside the
    // per-user Sender. Any user's mail teaches Rose what
    // `acme.com` looks like; every other user's UI gets the
    // logo / addresses / websites for free without paying their
    // own LLM brief.
    try {
      await upsertGlobalSenderBrand(userId, b);
    } catch (err) {
      logger.warn(
        { err, brandKey: b.brandKey },
        'sender-brand upsert failed (continuing)',
      );
    }
    try {
      // Plan: senders ARE organization entities. Upsert an Entity
      // row of type 'organization' keyed on the brandKey so the
      // /n/<key> page, the auto-linker, and the Codex Entities tab
      // all see one consistent record. Idempotent — the unique
      // (userId, key) index dedupes concurrent writes.
      await Entity.updateOne(
        { userId, key: b.brandKey },
        {
          $set: {
            displayName: b.name || b.brandKey,
            type: 'organization',
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            userId,
            key: b.brandKey,
            pageCount: 0,
          },
        },
        { upsert: true },
      );
      // Organizations are global — populate the shared
      // Organization row alongside the per-user Entity. setOnInsert
      // on displayName means the FIRST sender-upsert wins the
      // canonical name; later writes don't clobber a name another
      // user (or the LLM extractor) already set.
      try {
        await Organization.updateOne(
          { key: b.brandKey },
          {
            $setOnInsert: {
              key: b.brandKey,
              displayName: b.name || b.brandKey,
              firstSeenBy: userId,
            },
          },
          { upsert: true },
        );
        // Ontology — best-effort Wikidata Q-ID resolution. Fire and
        // forget so a slow/down upstream doesn't delay page write.
        // Throttled to 90 days per row inside the resolver.
        void enrichOrganizationWikidata(b.brandKey).catch(() => null);
      } catch (err) {
        logger.debug(
          { err, brandKey: b.brandKey },
          'sender → organization upsert failed (continuing)',
        );
      }
    } catch (err) {
      logger.warn(
        { err, brandKey: b.brandKey, userId: String(userId) },
        'sender → entity upsert failed (continuing)',
      );
    }

    try {
      const existing = await Sender.findOne({ userId, brandKey: b.brandKey });
      const now = new Date();
      if (!existing) {
        // Plan 15 — Sender stores only per-user state. All
        // brand-global writes (logo, addresses, websites, etc.)
        // happen above via `upsertGlobalSenderBrand`.
        const created = await Sender.create({
          userId,
          brandKey: b.brandKey,
          emailCount: b.emails.length,
          pageCount: pageWasNew ? 1 : 0,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        // Auto-generate the brief on first sight when the brand
        // doesn't already have one. Plan 15 — the brief lives on
        // SenderBrand globally; if any other user has already
        // triggered a summarize for this brand we skip and let the
        // shared brief serve. Idempotent: jobId scoped to brand
        // so concurrent first-sights from multiple users collapse.
        try {
          const brand = await SenderBrand.findOne({ brandKey: b.brandKey })
            .select('summary')
            .lean();
          if (!brand?.summary) {
            await summarizeQueue.add(
              'summarize',
              { senderId: String(created._id), userId: String(userId) },
              {
                jobId: `auto__brand__${b.brandKey}`,
                attempts: 2,
                removeOnComplete: 200,
                removeOnFail: 200,
              },
            );
          }
        } catch (err) {
          logger.warn(
            { err, brandKey: b.brandKey },
            'auto-summarize enqueue failed (continuing)',
          );
        }
        continue;
      }
      // Existing per-user row — bump counters only. Brand-global
      // updates happened above on the SenderBrand row.
      existing.emailCount = (existing.emailCount ?? 0) + b.emails.length;
      if (pageWasNew) existing.pageCount = (existing.pageCount ?? 0) + 1;
      existing.lastSeenAt = now;
      await existing.save();

      // Auto-summarise when the BRAND has no brief yet. Replaces
      // the pre-plan-15 per-user check (`!existing.summary &&
      // !existing.summaryLocked`); the brief's home is SenderBrand
      // now.
      const brand = await SenderBrand.findOne({ brandKey: b.brandKey })
        .select('summary')
        .lean();
      if (!brand?.summary) {
        try {
          await summarizeQueue.add(
            'summarize',
            { senderId: String(existing._id), userId: String(userId) },
            {
              jobId: `auto__brand__${b.brandKey}`,
              attempts: 2,
              removeOnComplete: 200,
              removeOnFail: 200,
            },
          );
        } catch (err) {
          logger.warn(
            { err, brandKey: b.brandKey },
            'auto-summarize enqueue failed (continuing)',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, brandKey: b.brandKey, userId: String(userId) },
        'sender upsert failed (continuing)',
      );
    }
  }
}
