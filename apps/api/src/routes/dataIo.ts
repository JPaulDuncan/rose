import { Router } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import {
  Page,
  PageRevision,
  Conversation,
  Message,
  CalendarEvent,
  Sender,
  Rule,
  User,
  Entity,
  TagCanonical,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const dataIoRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

/**
 * Bumped to 2 in plan 12 (G8) when the export grew to cover the
 * Entity + TagCanonical collections (and Page.mergeSuggestions
 * round-trips via the existing `pages` payload). Imports of v1 are
 * still accepted — those collections just come up empty.
 */
const EXPORT_VERSION = 2;

/**
 * Stream the user's portable wiki state as a single JSON document.
 * Skips: encrypted source credentials, embeddings, push subscriptions,
 * VAPID secrets, anything tied to a specific install. Includes
 * everything needed to seed a fresh account: pages, revisions,
 * conversations, calendar events, senders, rules, saved searches,
 * preferences.
 *
 * Streamed as application/json (gzipped by upstream nginx in prod).
 * Synchronous read — for typical wikis (≤ 10k pages) this completes
 * in seconds and avoids the operational complexity of staged exports
 * + temp file cleanup.
 */
dataIoRouter.get('/export', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));

  const [
    user,
    pages,
    conversations,
    messages,
    events,
    senders,
    rules,
    entities,
    tagCanonicals,
  ] = await Promise.all([
    User.findById(userId)
      .select(
        'email displayName settings spamPolicy featuredTags weatherLocation savedSearches',
      )
      .lean(),
    Page.find({ userId })
      // Page.mergeSuggestions[] is small + already on the page doc;
      // exporting it lets a re-import preserve a user's pending
      // dismissals (so re-detection doesn't immediately re-suggest).
      .select('-embedding -topicCentroid')
      .lean(),
    Conversation.find({ userId }).lean(),
    Message.find({ userId }).sort({ createdAt: 1 }).lean(),
    CalendarEvent.find({ userId }).lean(),
    Sender.find({ userId }).lean(),
    Rule.find({ userId }).lean(),
    Entity.find({ userId }).select('-embedding').lean(),
    TagCanonical.find({ userId }).select('-embedding').lean(),
  ]);

  // Revisions need the page IDs, fetch separately so the type inference
  // for the parallel Promise.all stays clean.
  const pageIds = pages.map((p) => p._id);
  const allRevisions = pageIds.length
    ? await PageRevision.find({ pageId: { $in: pageIds } }).lean()
    : [];

  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="rose-export-${new Date()
      .toISOString()
      .slice(0, 10)}.json"`,
  });
  res.json({
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    user: user
      ? {
          email: user.email,
          displayName: user.displayName,
          settings: user.settings ?? {},
          spamPolicy: user.spamPolicy ?? { senders: [], tags: [] },
          featuredTags: user.featuredTags ?? [],
          weatherLocation: user.weatherLocation ?? null,
          savedSearches: user.savedSearches ?? [],
        }
      : null,
    counts: {
      pages: pages.length,
      revisions: allRevisions.length,
      conversations: conversations.length,
      messages: messages.length,
      events: events.length,
      senders: senders.length,
      rules: rules.length,
      entities: entities.length,
      tagCanonicals: tagCanonicals.length,
    },
    pages,
    revisions: allRevisions,
    conversations,
    messages,
    events,
    senders,
    rules,
    entities,
    tagCanonicals,
  });
});

/**
 * Replace every collection scoped to this user with the contents of
 * the uploaded export. Sources / outbound / push subscriptions are
 * NOT touched — the operator's IMAP/Gmail credentials and the
 * device's WebPush registration shouldn't roundtrip with portable
 * wiki state.
 *
 * Confirmation: the client must include `confirm: 'REPLACE'` in the
 * multipart form to proceed. Anything else 400s.
 */
dataIoRouter.post('/import', upload.single('file'), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'invalid_request', message: 'No file uploaded' });
    return;
  }
  const confirm = (req.body?.confirm ?? '') as string;
  if (confirm.trim().toUpperCase() !== 'REPLACE') {
    res.status(400).json({
      error: 'confirmation_required',
      message: 'Pass confirm=REPLACE to proceed. Import is destructive.',
    });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(file.buffer.toString('utf8')) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid JSON' });
    return;
  }
  // Accept v1 (pre-entities/tag-canonicals) too — those imports
  // just come up with empty Entity / TagCanonical collections.
  const version = parsed.version as number;
  if (version !== EXPORT_VERSION && version !== 1) {
    res.status(400).json({
      error: 'invalid_request',
      message: `Unsupported export version: ${parsed.version}`,
    });
    return;
  }

  // Wipe the user's existing data first so import isn't merge-y.
  // Pages first because the revisions FK lives on PageId.
  const oldPages = await Page.find({ userId }).select('_id').lean();
  const oldIds = oldPages.map((p) => p._id);
  await Promise.all([
    PageRevision.deleteMany({ pageId: { $in: oldIds } }),
    Page.deleteMany({ userId }),
    Message.deleteMany({ userId }),
    Conversation.deleteMany({ userId }),
    CalendarEvent.deleteMany({ userId }),
    Sender.deleteMany({ userId }),
    Rule.deleteMany({ userId }),
    Entity.deleteMany({ userId }),
    TagCanonical.deleteMany({ userId }),
  ]);

  // Re-insert. We rewrite ObjectIds onto a clean ID-space rooted at
  // this user — safer than reusing the export's IDs (which could
  // collide with this user's existing rows once we re-insert).
  const idMap = new Map<string, Types.ObjectId>();
  const remap = (oldId: string | Types.ObjectId | undefined): Types.ObjectId | null => {
    if (!oldId) return null;
    const key = String(oldId);
    let next = idMap.get(key);
    if (!next) {
      next = new Types.ObjectId();
      idMap.set(key, next);
    }
    return next;
  };

  const importedPages = ((parsed.pages as Record<string, unknown>[]) ?? []).map((p) => {
    const newId = remap(p._id as string)!;
    return { ...p, _id: newId, userId };
  });
  if (importedPages.length) await Page.insertMany(importedPages, { ordered: false });

  const importedRevisions = ((parsed.revisions as Record<string, unknown>[]) ?? []).map(
    (r) => ({
      ...r,
      _id: new Types.ObjectId(),
      pageId: remap(r.pageId as string),
    }),
  );
  if (importedRevisions.length)
    await PageRevision.insertMany(importedRevisions, { ordered: false });

  const importedConvs = ((parsed.conversations as Record<string, unknown>[]) ?? []).map(
    (c) => {
      const newId = remap(c._id as string)!;
      return { ...c, _id: newId, userId };
    },
  );
  if (importedConvs.length) await Conversation.insertMany(importedConvs, { ordered: false });

  const importedMsgs = ((parsed.messages as Record<string, unknown>[]) ?? []).map((m) => ({
    ...m,
    _id: new Types.ObjectId(),
    userId,
    conversationId: remap(m.conversationId as string),
  }));
  if (importedMsgs.length) await Message.insertMany(importedMsgs, { ordered: false });

  const importedEvents = ((parsed.events as Record<string, unknown>[]) ?? []).map((e) => ({
    ...e,
    _id: new Types.ObjectId(),
    userId,
    sourceEmailId: null,
    pageId: remap(e.pageId as string),
  }));
  if (importedEvents.length)
    await CalendarEvent.insertMany(importedEvents, { ordered: false });

  const importedSenders = ((parsed.senders as Record<string, unknown>[]) ?? []).map((s) => ({
    ...s,
    _id: new Types.ObjectId(),
    userId,
  }));
  if (importedSenders.length) await Sender.insertMany(importedSenders, { ordered: false });

  const importedRules = ((parsed.rules as Record<string, unknown>[]) ?? []).map((r) => ({
    ...r,
    _id: new Types.ObjectId(),
    userId,
  }));
  if (importedRules.length) await Rule.insertMany(importedRules, { ordered: false });

  const importedEntities = ((parsed.entities as Record<string, unknown>[]) ?? []).map(
    (e) => ({
      ...e,
      _id: new Types.ObjectId(),
      userId,
    }),
  );
  if (importedEntities.length)
    await Entity.insertMany(importedEntities, { ordered: false });

  const importedTagCanonicals = (
    (parsed.tagCanonicals as Record<string, unknown>[]) ?? []
  ).map((t) => ({
    ...t,
    _id: new Types.ObjectId(),
    userId,
  }));
  if (importedTagCanonicals.length)
    await TagCanonical.insertMany(importedTagCanonicals, { ordered: false });

  // User-level fields — replace settings + savedSearches + spamPolicy
  // + featuredTags + weatherLocation. Don't touch email, password,
  // providers (those are install-specific).
  const userPayload = (parsed.user ?? {}) as Record<string, unknown>;
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        settings: userPayload.settings ?? {},
        spamPolicy: userPayload.spamPolicy ?? { senders: [], tags: [] },
        featuredTags: userPayload.featuredTags ?? [],
        weatherLocation: userPayload.weatherLocation ?? null,
        savedSearches: userPayload.savedSearches ?? [],
      },
    },
  );

  res.json({
    ok: true,
    counts: {
      pages: importedPages.length,
      revisions: importedRevisions.length,
      conversations: importedConvs.length,
      messages: importedMsgs.length,
      events: importedEvents.length,
      senders: importedSenders.length,
      rules: importedRules.length,
      entities: importedEntities.length,
      tagCanonicals: importedTagCanonicals.length,
    },
  });
});
