import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { google } from 'googleapis';
import { Source, CalendarEvent } from '@rose/db';
import type { GcalConfig } from '@rose/shared';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';

const QUEUE = 'rose.gcal-sync';

type GcalJobData = { sourceId: string; userId: string };

type GcalStored = GcalConfig & {
  refreshToken?: string;
  /** Per-calendar incremental syncToken returned by Google. */
  syncTokens?: Record<string, string>;
};

/** Map a Google event into the local CalendarEvent shape. */
function mapEvent(
  e: {
    id?: string | null;
    summary?: string | null;
    description?: string | null;
    location?: string | null;
    start?: { date?: string | null; dateTime?: string | null };
    end?: { date?: string | null; dateTime?: string | null };
    status?: string | null;
  },
  userId: Types.ObjectId,
  sourceLabel: string,
): {
  start: Date;
  end: Date | null;
  allDay: boolean;
  doc: Record<string, unknown>;
} | null {
  const startStr = e.start?.dateTime ?? e.start?.date;
  const endStr = e.end?.dateTime ?? e.end?.date;
  if (!startStr) return null;
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const start = new Date(startStr);
  const end = endStr ? new Date(endStr) : null;
  return {
    start,
    end,
    allDay,
    doc: {
      userId,
      sourceEmailId: null,
      pageId: null,
      pageSlug: null,
      title: (e.summary ?? '(no title)').slice(0, 200),
      start,
      end,
      allDay,
      location: (e.location ?? null) as string | null,
      description: (e.description ?? '').slice(0, 4000),
      // Stash the gcal id so we de-dupe across syncs.
      // Source field uses the convention `gcal:<calendarId>:<eventId>`.
      gcalId: `gcal:${sourceLabel}:${e.id ?? ''}`,
    },
  };
}

export function startGcalSyncWorker() {
  const worker = new Worker<GcalJobData>(
    QUEUE,
    async (job: Job<GcalJobData>) => {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new Error('Google OAuth credentials not configured');
      }
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (!source || source.type !== 'gcal' || !source.encryptedConfig) return;

      const stored = decryptJson<GcalStored>(source.encryptedConfig);
      const oauth2 = new google.auth.OAuth2(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REDIRECT_URI,
      );

      // First-run: exchange the auth code for a refresh token.
      if (!stored.refreshToken && stored.authCode) {
        try {
          const { tokens } = await oauth2.getToken(stored.authCode);
          if (!tokens.refresh_token) {
            throw new Error(
              'Google did not return a refresh_token. Re-issue the auth URL with prompt=consent.',
            );
          }
          stored.refreshToken = tokens.refresh_token;
          stored.authCode = undefined;
          source.encryptedConfig = encryptJson(stored);
        } catch (err) {
          source.lastError = (err as Error).message;
          source.status = 'error';
          await source.save();
          throw err;
        }
      }
      oauth2.setCredentials({ refresh_token: stored.refreshToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });

      // Determine which calendars to pull. Empty list = primary only.
      const calendarIds = stored.calendarIds?.length ? stored.calendarIds : ['primary'];
      const syncTokens = stored.syncTokens ?? {};

      let upserted = 0;
      let removed = 0;
      const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);

      for (const calendarId of calendarIds) {
        try {
          const syncToken = syncTokens[calendarId];
          // Incremental sync uses syncToken; first run fetches recent
          // events and captures a syncToken in the response.
          const baseParams = syncToken
            ? { calendarId, syncToken }
            : {
                calendarId,
                singleEvents: true,
                orderBy: 'startTime' as const,
                timeMin: since.toISOString(),
              };
          let pageToken: string | undefined;
          let nextSyncToken: string | undefined;
          do {
            const res = await calendar.events.list({ ...baseParams, pageToken });
            for (const e of res.data.items ?? []) {
              if (e.status === 'canceled') {
                if (e.id) {
                  const r = await CalendarEvent.deleteOne({
                    userId,
                    gcalId: `gcal:${calendarId}:${e.id}`,
                  });
                  if ((r.deletedCount ?? 0) > 0) removed += 1;
                }
                continue;
              }
              const mapped = mapEvent(e, userId, calendarId);
              if (!mapped) continue;
              await CalendarEvent.updateOne(
                { userId, gcalId: mapped.doc.gcalId as string },
                { $set: mapped.doc },
                { upsert: true },
              );
              upserted += 1;
            }
            pageToken = res.data.nextPageToken ?? undefined;
            nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
          } while (pageToken);
          if (nextSyncToken) syncTokens[calendarId] = nextSyncToken;
        } catch (err) {
          // 410 GONE on syncToken means we've fallen too far behind;
          // drop the token and let next sync do a full re-pull.
          const status = (err as { code?: number }).code;
          if (status === 410) {
            delete syncTokens[calendarId];
            logger.warn({ calendarId }, 'gcal-sync: syncToken expired; full re-pull next time');
          } else {
            logger.warn(
              { err: (err as Error).message, calendarId },
              'gcal-sync: per-calendar failure (continuing)',
            );
          }
        }
      }

      stored.syncTokens = syncTokens;
      source.encryptedConfig = encryptJson(stored);
      source.lastSyncAt = new Date();
      source.lastError = null;
      source.status = 'active';
      await source.save();
      logger.info(
        { sourceId: String(source._id), upserted, removed, calendars: calendarIds.length },
        'gcal-sync: done',
      );
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'gcal-sync failed'),
  );
  return worker;
}
