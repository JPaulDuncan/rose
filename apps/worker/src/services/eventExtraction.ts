import { Types } from 'mongoose';
import { CalendarEvent, Email, Instruction, User, type EmailDoc, type PageDoc } from '@rose/db';
import { extractJson, renderTemplate } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';
import { geocode } from '../lib/geocode.js';

type ExtractedEvent = {
  title: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string;
};

function parseExtractedDate(s: string, allDay: boolean): Date | null {
  if (!s) return null;
  // ISO with time: parse as-is. ISO date-only: anchor to local midnight.
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Run the user's `extract.events` instruction over a single email and persist
 * any concrete events found. Replaces any prior events from the same email
 * (idempotent).
 */
export async function extractEventsForEmail(
  email: EmailDoc,
  page: PageDoc | null,
): Promise<number> {
  const userId = email.userId as Types.ObjectId;

  const tpl =
    (await Instruction.findOne({ userId, scope: 'events', isDefault: true })) ??
    (await Instruction.findOne({ userId, scope: 'events', isSystem: true }));
  if (!tpl) {
    logger.warn({ userId: String(userId) }, 'no extract.events instruction available');
    return 0;
  }

  const body = (email.text || email.rawText || '').slice(0, 6000);
  if (!body.trim()) {
    email.eventsExtractedAt = new Date();
    await email.save();
    return 0;
  }

  const prompt = renderTemplate(tpl.template, {
    email_subject: email.subject ?? '',
    email_from: email.from?.address ?? '',
    email_date: email.date ? new Date(email.date).toISOString() : '',
    email_body: body,
  });

  let raw = '';
  try {
    const { provider, model } = await resolveProviderForUser(userId, 'generation');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      for await (const chunk of provider.generateStream({
        model,
        prompt,
        format: 'json',
        temperature: 0.1,
        signal: ctrl.signal,
      })) {
        raw += chunk.response;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn({ err, emailId: String(email._id) }, 'event extraction LLM call failed');
    return 0;
  }

  let events: ExtractedEvent[] = [];
  try {
    const parsed = extractJson<{ events?: ExtractedEvent[] }>(raw);
    events = Array.isArray(parsed?.events) ? parsed.events : [];
  } catch (err) {
    logger.warn({ err, raw: raw.slice(0, 200) }, 'event extraction returned non-JSON');
  }

  // Replace any prior events from this email — idempotent reruns.
  await CalendarEvent.deleteMany({ userId, sourceEmailId: email._id });

  let inserted = 0;
  const emailDate = email.date ? new Date(email.date) : new Date();
  // Reject events more than 7 days in the past relative to the email's send
  // date (model occasionally surfaces references to historical dates).
  const minStart = new Date(emailDate.getTime() - 7 * 24 * 3600 * 1000);

  // Maps opt-in: when on, we geocode each new event's location
  // string via Nominatim. Cached 30d in Redis so repeated venues
  // (recurring meetings, popular conferences) cost one upstream
  // call across all users. Plan 11.
  const userDoc = await User.findById(userId).select('settings.maps').lean();
  const mapsEnabled = !!(
    (userDoc?.settings as { maps?: { enabled?: boolean } } | undefined)?.maps?.enabled
  );

  for (const e of events) {
    if (!e?.title || !e?.start) continue;
    const allDay = !!e.allDay;
    const start = parseExtractedDate(e.start, allDay);
    if (!start || start < minStart) continue;
    const end = e.end ? parseExtractedDate(e.end, allDay) : null;
    const location = e.location ? String(e.location).slice(0, 200) : null;

    let geocoded:
      | { lat: number; lon: number; displayName: string; at: Date }
      | null = null;
    let geocodeFailed = false;
    if (mapsEnabled && location) {
      try {
        const r = await geocode(location);
        if (r) {
          geocoded = { ...r, at: new Date() };
        } else {
          geocodeFailed = true;
        }
      } catch (err) {
        logger.warn({ err, location }, 'event geocode failed (continuing)');
        geocodeFailed = true;
      }
    }

    await CalendarEvent.create({
      userId,
      sourceEmailId: email._id,
      pageId: page?._id ?? null,
      pageSlug: page?.slug ?? null,
      title: String(e.title).slice(0, 200),
      start,
      end: end && end > start ? end : null,
      allDay,
      location,
      geocoded: geocoded ?? {
        lat: null,
        lon: null,
        displayName: null,
        at: null,
      },
      geocodeFailed,
      geocodeFailedAt: geocodeFailed ? new Date() : null,
      description: e.description ? String(e.description).slice(0, 500) : '',
    });
    inserted += 1;
  }

  email.eventsExtractedAt = new Date();
  await email.save();
  return inserted;
}

/**
 * After a page is created/updated, ensure events are extracted for every
 * source email. Skips emails already extracted unless `force: true`.
 */
export async function extractEventsForPage(
  page: PageDoc,
  emails: EmailDoc[],
  opts: { force?: boolean } = {},
): Promise<number> {
  let total = 0;
  for (const e of emails) {
    if (!opts.force && e.eventsExtractedAt) continue;
    try {
      total += await extractEventsForEmail(e, page);
    } catch (err) {
      logger.warn({ err, emailId: String(e._id) }, 'extractEventsForEmail crashed');
    }
  }
  return total;
}

/** When an email is replaced/deleted, drop its events too. */
export async function deleteEventsForEmail(emailId: Types.ObjectId): Promise<void> {
  await CalendarEvent.deleteMany({ sourceEmailId: emailId });
}

/** When a page is regenerated under a new slug, update cached pageSlug. */
export async function syncEventsToPage(
  pageId: Types.ObjectId,
  pageSlug: string,
): Promise<void> {
  await CalendarEvent.updateMany({ pageId }, { $set: { pageSlug } });
  // Also re-link any event whose email now belongs to this page.
  const emails = await Email.find({ pageId }).select('_id').lean();
  if (emails.length) {
    await CalendarEvent.updateMany(
      { sourceEmailId: { $in: emails.map((e) => e._id) } },
      { $set: { pageId, pageSlug } },
    );
  }
}
