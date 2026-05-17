import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Source, CalendarEvent } from '@rose/db';
import {
  parseIcs,
  normalizeCalendarUrl,
  InvalidCalendarUrlError,
  type IcsConfig,
} from '@rose/shared';
import { assertSafeHttpUrl, browserFeedHeaders } from '@rose/llm';
import { decryptJson } from '../lib/crypto.js';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.ics-sync';

type IcsJobData = { sourceId: string; userId: string };

/**
 * ICS calendar subscription syncer. Fetches the resolved feed URL
 * with conditional-GET headers, parses VEVENTs, upserts to
 * CalendarEvent keyed on `ics:<sourceId>:<UID>` so re-runs are
 * idempotent and a UID collision across two different ICS feeds
 * doesn't conflate events.
 *
 * Recurrence: we don't expand RRULE in this pass. The master event
 * is ingested with `hasRecurrence` noted on the parser side but
 * dropped on persist — recurring events show up as their first
 * instance. Users who need full recurrence should use the OAuth
 * `gcal` path which gets it from Google's API. v2 of this worker
 * can add `rrule` expansion if it becomes a real limitation.
 *
 * Re-normalises the URL on every run rather than trusting the
 * cached `icsResolvedUrl` — if the user pasted a Google cid= link
 * and we ever change the public-ICS path convention, the fix lands
 * automatically on the next sync.
 */
export function startIcsSyncWorker() {
  const worker = new Worker<IcsJobData>(
    QUEUE,
    async (job: Job<IcsJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (!source || source.type !== 'ics' || !source.encryptedConfig) return;

      const cfg = decryptJson<IcsConfig>(source.encryptedConfig);
      let resolvedUrl: string;
      try {
        // Re-resolve from the user-pasted URL on every sync — cheap,
        // and means a fix to normalizeCalendarUrl applies retroactively.
        resolvedUrl = normalizeCalendarUrl(cfg.url);
      } catch (err) {
        const msg =
          err instanceof InvalidCalendarUrlError
            ? err.message
            : (err as Error).message;
        source.lastError = `Invalid calendar URL: ${msg}`;
        source.status = 'error';
        await source.save();
        throw err;
      }
      await assertSafeHttpUrl(resolvedUrl);

      const headers: Record<string, string> = { ...browserFeedHeaders(resolvedUrl) };
      if (source.icsEtag) headers['If-None-Match'] = source.icsEtag;
      if (source.icsLastModified) headers['If-Modified-Since'] = source.icsLastModified;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let res: Response;
      try {
        try {
          res = await fetch(resolvedUrl, {
            headers,
            redirect: 'follow',
            signal: ctrl.signal,
          });
        } catch (err) {
          source.lastError = (err as Error).message;
          source.status = 'error';
          await source.save();
          throw err;
        }
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 304) {
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
        logger.info({ sourceId: String(source._id) }, 'ics-sync: not modified');
        return;
      }
      if (!res.ok) {
        const msg = `Calendar feed responded ${res.status} ${res.statusText}`;
        source.lastError = msg;
        source.status = 'error';
        await source.save();
        throw new Error(msg);
      }

      // Hard cap so a runaway feed (multi-MB holiday calendar with
      // 50 years of history) can't blow the worker's memory.
      const cap = 8 * 1024 * 1024;
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > cap) {
            ctrl.abort();
            throw new Error(`ICS body exceeded ${cap} byte cap`);
          }
          chunks.push(value);
        }
      }
      const ics = parseIcs(Buffer.concat(chunks).toString('utf-8'));

      const backfillDays = cfg.historicalBackfillDays ?? 365;
      const cutoff = new Date(Date.now() - backfillDays * 24 * 3600 * 1000);
      const maxPerSync = cfg.maxPerSync ?? 1000;

      type Eligible = {
        uid: string;
        summary: string;
        start: Date;
        end: Date | null;
        allDay: boolean;
        location: string;
        description: string;
      };
      // Filter + narrow the `start` non-null in one pass — TS doesn't
      // refine through `.filter` so we use `reduce` to commit to the
      // narrower type.
      const eligible = ics.events.reduce<Eligible[]>((acc, e) => {
        if (acc.length >= maxPerSync) return acc;
        if (!e.uid || !e.start || e.start < cutoff) return acc;
        acc.push({
          uid: e.uid,
          summary: e.summary,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          location: e.location,
          description: e.description,
        });
        return acc;
      }, []);

      // Bulk-upsert. Mongoose's bulkWrite isn't materially faster
      // than a for-loop for ~1000 docs, but the writeBatch is one
      // round-trip per N documents which beats per-event round-trips.
      const ops = eligible.map((ev) => ({
        updateOne: {
          filter: {
            userId,
            icsUid: `ics:${String(source._id)}:${ev.uid}`,
          },
          update: {
            $set: {
              userId,
              icsUid: `ics:${String(source._id)}:${ev.uid}`,
              title: (ev.summary || '(untitled event)').slice(0, 200),
              kind: 'event' as const,
              start: ev.start,
              end: ev.end,
              allDay: ev.allDay,
              location: ev.location || null,
              description: ev.description || '',
            },
          },
          upsert: true,
        },
      }));
      let upserted = 0;
      let modified = 0;
      if (ops.length > 0) {
        const r = await CalendarEvent.bulkWrite(ops, { ordered: false });
        upserted = r.upsertedCount ?? 0;
        modified = r.modifiedCount ?? 0;
      }

      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag) source.icsEtag = etag;
      if (lastModified) source.icsLastModified = lastModified;
      source.icsResolvedUrl = resolvedUrl;
      if (ics.name) source.icsCalendarName = ics.name.slice(0, 200);
      source.lastSyncAt = new Date();
      source.lastError = null;
      source.status = 'active';
      await source.save();

      logger.info(
        {
          sourceId: String(source._id),
          eligible: eligible.length,
          totalInFeed: ics.events.length,
          upserted,
          modified,
        },
        'ics-sync: done',
      );
    },
    { connection: bullConnection(), concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'ics-sync failed'),
  );
  return worker;
}
