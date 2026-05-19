import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Entity,
  MemoryComponent,
  MemoryGroup,
  DaydreamNote,
  Page,
  daydreamSubjectKey,
} from '@rose/db';

type EntityRow = {
  _id: Types.ObjectId;
  key: string;
  displayName: string;
  type: 'person' | 'work' | 'organization' | 'place';
  aliases?: string[];
  pageCount?: number;
  lastSeenAt?: Date;
  wikidataId?: string | null;
  wikidataConfidence?: number;
};
import { userIdOf } from '../middleware/auth.js';

export const knowledgeRouter: Router = Router();

/**
 * Unified "what Rose knows" surface. Composes three previously-
 * separate views into one endpoint:
 *
 *   • subject=user   — atomic facts ABOUT the user, grouped into
 *                      themes (same shape as /api/memory).
 *   • subject=world  — entities + their associated atomic facts +
 *                      their daydream note prose, rolled up into
 *                      per-entity cards. Plus a "loose facts"
 *                      bucket for world-facts that don't match any
 *                      registered entity.
 *
 * The data model behind this is unchanged — Entity, MemoryComponent,
 * MemoryGroup, DaydreamNote all stay as separate collections. This
 * endpoint just JOINS them so the UI doesn't have to fan out 3
 * round-trips.
 *
 * Matching world-facts to entities: client-side substring against
 * entity.displayName with a word-boundary check (mirroring
 * xRetrieveWorldFacts), so "A24" doesn't accidentally match a
 * component about "A24K of gold." Many-to-many — one fact can
 * land under multiple entity cards (e.g., "Stripe acquired
 * Bouncer in 2021" surfaces under both Stripe and Bouncer if both
 * are entities).
 */
knowledgeRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const subjectParam = (req.query.subject as string | undefined) ?? 'user';
  if (!['user', 'world'].includes(subjectParam)) {
    res.status(400).json({ error: 'invalid_subject' });
    return;
  }

  if (subjectParam === 'user') {
    // ── About you ────────────────────────────────────────────────
    // Mirror /api/memory's response shape exactly. The UI tab
    // reuses the existing Memory-page rendering against this data.
    const status = (req.query.status as string | undefined) ?? 'active';
    const filter: Record<string, unknown> = { userId, subject: 'user' };
    if (status !== 'all') filter.status = status;
    const [components, groups] = await Promise.all([
      MemoryComponent.find(filter)
        .sort({ lastSeenAt: -1 })
        .limit(1000)
        .select('-embedding')
        .lean(),
      MemoryGroup.find({ userId, subject: 'user' })
        .sort({ componentCount: -1 })
        .select('-centroid')
        .lean(),
    ]);
    const sourcePageIds = new Set<string>();
    for (const c of components) {
      for (const pid of (c.sourcePageIds as Types.ObjectId[] | undefined) ?? []) {
        sourcePageIds.add(String(pid));
      }
    }
    const pages = sourcePageIds.size
      ? await Page.find({
          userId,
          _id: { $in: [...sourcePageIds].map((id) => new Types.ObjectId(id)) },
        })
          .select('title slug')
          .lean()
      : [];
    const pageById = new Map(pages.map((p) => [String(p._id), p]));
    const decorated = components.map((c) => ({
      ...c,
      sources: ((c.sourcePageIds as Types.ObjectId[] | undefined) ?? [])
        .slice(0, 3)
        .map((pid) => {
          const p = pageById.get(String(pid));
          return p ? { id: String(p._id), title: p.title, slug: p.slug } : null;
        })
        .filter(Boolean),
    }));
    res.json({
      subject: 'user',
      components: decorated,
      groups,
      totals: {
        components: components.length,
        groups: groups.length,
      },
    });
    return;
  }

  // ── About the world ──────────────────────────────────────────────
  // Three reads in parallel:
  //   1. Entities (registry rows — the per-user keyed subjects)
  //   2. World-facts (atomic claims with subject='world')
  //   3. DaydreamNotes for entity-kind subjects belonging to this
  //      user (notes are global; ownership is via firstResearchedBy
  //      + the daydream sweeper scopes per user). We pull every
  //      note whose subjectKey is in the user's entity-key set so
  //      we don't load notes for entities the user doesn't have.
  const entityTypeFilter = (req.query.type as string | undefined) ?? null;
  const entityFilter: Record<string, unknown> = { userId };
  if (
    entityTypeFilter &&
    ['person', 'place', 'organization', 'work'].includes(entityTypeFilter)
  ) {
    entityFilter.type = entityTypeFilter;
  }
  const [entities, components] = await Promise.all([
    Entity.find(entityFilter)
      .sort({ pageCount: -1, lastSeenAt: -1 })
      .limit(200)
      .lean() as unknown as Promise<EntityRow[]>,
    MemoryComponent.find({
      userId,
      subject: 'world',
      status: 'active',
    })
      .sort({ lastSeenAt: -1 })
      .limit(500)
      .select('-embedding')
      .lean(),
  ]);

  // DaydreamNote lookup — match by subjectKey from each entity's
  // displayName (which is exactly what the daydream worker uses
  // when persisting). Single batch query.
  const noteKeys = entities
    .map((e) => daydreamSubjectKey(e.displayName ?? ''))
    .filter(Boolean);
  const notes = noteKeys.length
    ? await DaydreamNote.find({
        kind: 'entity',
        subjectKey: { $in: noteKeys },
      })
        .select(
          'subjectKey displayName summary bodyMd sources confidence generatedAt model',
        )
        .lean()
    : [];
  const noteByKey = new Map(notes.map((n) => [n.subjectKey, n]));

  // Page source-citation lookup. Take ALL sourcePageIds across
  // components + DaydreamNote sources, batch-resolve to titles +
  // slugs.
  const pageIds = new Set<string>();
  for (const c of components) {
    for (const pid of (c.sourcePageIds as Types.ObjectId[] | undefined) ?? []) {
      pageIds.add(String(pid));
    }
  }
  const pages = pageIds.size
    ? await Page.find({
        userId,
        _id: { $in: [...pageIds].map((id) => new Types.ObjectId(id)) },
      })
        .select('title slug')
        .lean()
    : [];
  const pageById = new Map(pages.map((p) => [String(p._id), p]));
  const decorateSources = (c: (typeof components)[number]) =>
    ((c.sourcePageIds as Types.ObjectId[] | undefined) ?? [])
      .slice(0, 3)
      .map((pid) => {
        const p = pageById.get(String(pid));
        return p ? { id: String(p._id), title: p.title, slug: p.slug } : null;
      })
      .filter(Boolean);

  // Match world-facts to entities. Word-boundary substring on
  // entity.displayName (case-insensitive). Same algorithm as
  // xRetrieveWorldFacts so what shows up here is what daydream
  // would retrieve.
  const usedComponentIds = new Set<string>();
  const entityCards = entities.map((e) => {
    const display = (e.displayName ?? '').trim();
    if (!display) {
      return {
        entity: serializeEntity(e),
        daydreamNote: noteByKey.get(daydreamSubjectKey(display)) ?? null,
        facts: [],
      };
    }
    const re = new RegExp(`\\b${escapeRegex(display)}\\b`, 'i');
    const matched = components.filter((c) => re.test(c.text));
    for (const m of matched) usedComponentIds.add(String(m._id));
    return {
      entity: serializeEntity(e),
      daydreamNote: noteByKey.get(daydreamSubjectKey(display)) ?? null,
      facts: matched.slice(0, 12).map((c) => ({
        _id: String(c._id),
        type: c.type,
        text: c.text,
        confidence: c.confidence,
        status: c.status,
        sources: decorateSources(c),
        lastSeenAt: c.lastSeenAt,
      })),
    };
  });

  // Loose facts: world-facts not matched to any entity. Bottom
  // bucket so the user can still see + edit them. The user might
  // decide to register one as a new entity (future PR) or just
  // mark wrong / archive.
  const looseFacts = components
    .filter((c) => !usedComponentIds.has(String(c._id)))
    .slice(0, 100)
    .map((c) => ({
      _id: String(c._id),
      type: c.type,
      text: c.text,
      confidence: c.confidence,
      status: c.status,
      sources: decorateSources(c),
      lastSeenAt: c.lastSeenAt,
    }));

  res.json({
    subject: 'world',
    entities: entityCards,
    looseFacts,
    totals: {
      entities: entities.length,
      facts: components.length,
      facts_matched: usedComponentIds.size,
      facts_loose: looseFacts.length,
    },
  });
});

function serializeEntity(e: EntityRow) {
  return {
    _id: String(e._id),
    key: e.key,
    displayName: e.displayName,
    type: e.type,
    aliases: (e.aliases as string[] | undefined) ?? [],
    pageCount: e.pageCount ?? 0,
    lastSeenAt: e.lastSeenAt,
    wikidataId: e.wikidataId ?? null,
    wikidataConfidence: e.wikidataConfidence ?? 0,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
