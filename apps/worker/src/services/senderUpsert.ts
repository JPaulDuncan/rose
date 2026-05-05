import { Types } from 'mongoose';
import { Queue } from 'bullmq';
import { Sender, type EmailDoc, type PageDoc } from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

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
 */
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
    try {
      const existing = await Sender.findOne({ userId, brandKey: b.brandKey });
      const now = new Date();
      if (!existing) {
        // New sender — pick the strongest logo we can: prefer one
        // extracted from email content; otherwise fall back to the
        // domain's favicon via DuckDuckGo's icon service. The
        // fallback gets a low confidence so a future email-derived
        // logo can override it.
        const fallbackLogoUrl = b.logo?.url
          ? null
          : defaultLogoUrlForDomain(b.brandKey, b.domain);
        const logoUrl = b.logo?.url ?? fallbackLogoUrl ?? null;
        const logoConfidence = b.logo?.confidence ?? (fallbackLogoUrl ? 0.1 : 0);
        const created = await Sender.create({
          userId,
          brandKey: b.brandKey,
          name: b.name,
          domain: b.domain,
          addresses: [...b.addresses],
          websites: [...b.websites].slice(0, 30),
          unsubscribeUrls: [...b.unsubscribeUrls].slice(0, 4),
          logoUrl,
          logoConfidence,
          emailCount: b.emails.length,
          pageCount: pageWasNew ? 1 : 0,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        // Auto-generate the brief on first sight. Idempotent —
        // jobId scoped to (user, sender) so re-creates collapse.
        try {
          await summarizeQueue.add(
            'summarize',
            { senderId: String(created._id), userId: String(userId) },
            {
              jobId: `auto:${String(userId)}:${String(created._id)}`,
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
        continue;
      }
      // Merge addresses + websites + unsubscribe URLs without duplicates.
      const addrs = new Set<string>([...(existing.addresses ?? []), ...b.addresses]);
      const sites = new Set<string>([...(existing.websites ?? []), ...b.websites]);
      const unsub = new Set<string>([
        ...(existing.unsubscribeUrls ?? []),
        ...b.unsubscribeUrls,
      ]);
      existing.addresses = [...addrs];
      existing.websites = [...sites].slice(0, 30);
      existing.unsubscribeUrls = [...unsub].slice(0, 4);

      // Only update the logo when we have a stronger candidate AND the
      // user hasn't pinned theirs.
      if (
        !existing.logoLocked &&
        b.logo &&
        b.logo.confidence > (existing.logoConfidence ?? 0)
      ) {
        existing.logoUrl = b.logo.url;
        existing.logoConfidence = b.logo.confidence;
      }

      // Backfill: existing senders predating this code path may have
      // no logoUrl at all. Plug in the favicon fallback so they pick
      // up a default on the next regeneration without needing a
      // dedicated migration.
      if (!existing.logoLocked && !existing.logoUrl) {
        const fallback = defaultLogoUrlForDomain(b.brandKey, b.domain);
        if (fallback) {
          existing.logoUrl = fallback;
          existing.logoConfidence = 0.1;
        }
      }

      // Always keep `name` as the user-edited value if they set one,
      // otherwise prefer the brand-cased default we computed above.
      if (!existing.name || existing.name === existing.brandKey) {
        existing.name = b.name;
      }

      existing.emailCount = (existing.emailCount ?? 0) + b.emails.length;
      if (pageWasNew) existing.pageCount = (existing.pageCount ?? 0) + 1;
      existing.lastSeenAt = now;
      await existing.save();

      // Auto-summarise existing senders that have never been
      // briefed yet — covers users who upgrade past this commit
      // with a sender table that pre-dates auto-brief.
      if (!existing.summary && !existing.summaryLocked) {
        try {
          await summarizeQueue.add(
            'summarize',
            { senderId: String(existing._id), userId: String(userId) },
            {
              jobId: `auto:${String(userId)}:${String(existing._id)}`,
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
