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
  // Plan 13 (D7) — `importCollection` factors the per-collection
  // `.map(...).insertMany(...)` boilerplate that previously
  // repeated 7 times. The `transform` callback is where each
  // collection wires up its FK rewrites + per-row scrubs.
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

  type AnyDoc = Record<string, unknown>;
  type ModelLike = {
    insertMany: (
      arr: AnyDoc[],
      opts?: { ordered?: boolean },
    ) => Promise<unknown>;
  };

  /**
   * Map a slice of the export payload onto a fresh ObjectId-space and
   * insert. `preserveId` controls whether _id maps via the shared
   * idMap (so other collections' FKs to this row stay coherent — used
   * for Page, Conversation) or gets a brand-new one (collections
   * whose primary key isn't referenced anywhere — Sender, Rule,
   * Entity, TagCanonical, the per-message rows of Conversation).
   */
  async function importCollection({
    list,
    model,
    preserveId,
    transform,
  }: {
    list: AnyDoc[] | undefined;
    model: ModelLike;
    preserveId: boolean;
    transform?: (row: AnyDoc) => AnyDoc;
  }): Promise<number> {
    const arr = list ?? [];
    if (!arr.length) return 0;
    const mapped = arr.map((row) => {
      const base: AnyDoc = {
        ...row,
        _id: preserveId ? remap(row._id as string)! : new Types.ObjectId(),
        userId,
      };
      return transform ? transform(base) : base;
    });
    await model.insertMany(mapped, { ordered: false });
    return mapped.length;
  }

  const importedPagesCount = await importCollection({
    list: parsed.pages as AnyDoc[] | undefined,
    model: Page,
    preserveId: true,
  });
  const importedRevisionsCount = await importCollection({
    list: parsed.revisions as AnyDoc[] | undefined,
    model: PageRevision,
    // Revisions don't get back-referenced; only their `pageId` FK
    // matters and that has to remap onto the (possibly-rewritten)
    // page id.
    preserveId: false,
    transform: (r) => ({ ...r, pageId: remap(r.pageId as string) }),
  });
  const importedConvsCount = await importCollection({
    list: parsed.conversations as AnyDoc[] | undefined,
    model: Conversation,
    preserveId: true,
  });
  const importedMsgsCount = await importCollection({
    list: parsed.messages as AnyDoc[] | undefined,
    model: Message,
    preserveId: false,
    transform: (m) => ({
      ...m,
      conversationId: remap(m.conversationId as string),
    }),
  });
  const importedEventsCount = await importCollection({
    list: parsed.events as AnyDoc[] | undefined,
    model: CalendarEvent,
    preserveId: false,
    transform: (e) => ({
      ...e,
      sourceEmailId: null,
      pageId: remap(e.pageId as string),
    }),
  });
  const importedSendersCount = await importCollection({
    list: parsed.senders as AnyDoc[] | undefined,
    model: Sender,
    preserveId: false,
  });
  const importedRulesCount = await importCollection({
    list: parsed.rules as AnyDoc[] | undefined,
    model: Rule,
    preserveId: false,
  });
  const importedEntitiesCount = await importCollection({
    list: parsed.entities as AnyDoc[] | undefined,
    model: Entity,
    preserveId: false,
  });
  const importedTagCanonicalsCount = await importCollection({
    list: parsed.tagCanonicals as AnyDoc[] | undefined,
    model: TagCanonical,
    preserveId: false,
  });

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
      pages: importedPagesCount,
      revisions: importedRevisionsCount,
      conversations: importedConvsCount,
      messages: importedMsgsCount,
      events: importedEventsCount,
      senders: importedSendersCount,
      rules: importedRulesCount,
      entities: importedEntitiesCount,
      tagCanonicals: importedTagCanonicalsCount,
    },
  });
});
