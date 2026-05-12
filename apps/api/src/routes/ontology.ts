import { Router } from 'express';
import { Types } from 'mongoose';
import { EntityRelation, Entity, Organization, Page } from '@rose/db';
import {
  ONTOLOGY_VERSION,
  PREDICATES,
  predicateByKey,
  activePredicates,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';

export const ontologyRouter: Router = Router();

/**
 * Vocabulary — returns the active predicate catalogue plus metadata.
 * The web client uses this for label rendering and the (future)
 * admin UI for inspecting deprecation. Open to every authed user;
 * the catalogue is global state.
 */
ontologyRouter.get('/predicates', async (_req, res) => {
  res.json({
    version: ONTOLOGY_VERSION,
    // Send the full list (including deprecated) so the UI can label
    // historical EntityRelation rows that reference a now-retired
    // predicate without rendering "(unknown predicate)".
    predicates: PREDICATES.map((p) => ({
      key: p.key,
      label: p.label,
      inverseLabel: p.inverseLabel ?? p.label,
      subjectTypes: p.subjectTypes,
      objectTypes: p.objectTypes,
      schemaOrg: p.schemaOrg ?? null,
      wikidata: p.wikidata ?? null,
      introducedAt: p.introducedAt,
      deprecatedAt: p.deprecatedAt ?? null,
      description: p.description,
    })),
    active: activePredicates().map((p) => p.key),
  });
});

/**
 * List relations involving a given entity, scoped to relations
 * evidenced by the current user's archive. The endpoint accepts
 * either side via `?entity=<key>` — we surface every triple where
 * the entity appears as subject OR object, and the response
 * shapes the inverse for object-side rows so the UI can render
 * "X employs you" alongside "you employer X" without two queries.
 *
 * `?global=1` (admin-only) bypasses the per-user evidence filter
 * and returns every relation system-wide, useful for verifying
 * cross-user coverage of an org without leaking individual users'
 * archive contents.
 */
ontologyRouter.get('/relations', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const entity = (req.query.entity as string | undefined)?.toLowerCase().trim();
  if (!entity) {
    res.status(400).json({
      error: 'invalid_request',
      message: '`entity` query param is required',
    });
    return;
  }
  const globalView = req.query.global === '1';

  // Visibility rules:
  //   • `wikidataConfirmed: true` rows are public knowledge
  //     (sourced from Wikidata SPARQL) — visible to everyone.
  //   • Archive-sourced rows show only when this user's own pages
  //     evidenced them; mirrors the Daydream alignment pattern.
  //   • `?global=1` (admin path) bypasses the user filter entirely.
  const endpointFilter = { $or: [{ fromKey: entity }, { toKey: entity }] };
  const filter: Record<string, unknown> = globalView
    ? endpointFilter
    : {
        $and: [
          endpointFilter,
          {
            $or: [
              { wikidataConfirmed: true },
              { 'evidence.userId': userId },
            ],
          },
        ],
      };
  const rows = await EntityRelation.find(filter)
    .sort({ confidence: -1, updatedAt: -1 })
    .limit(200)
    .lean();

  // Resolve display names for every other endpoint in the rows so
  // the UI can render "Employer: Anthropic" without a follow-up
  // round trip. Pulls from per-user Entity (preferred for casing)
  // with a global Organization fallback.
  const otherKeys = new Set<string>();
  for (const r of rows) {
    if (r.fromKey !== entity) otherKeys.add(r.fromKey as string);
    if (r.toKey !== entity) otherKeys.add(r.toKey as string);
  }
  const [entityRows, orgRows] = await Promise.all([
    otherKeys.size
      ? Entity.find({ userId, key: { $in: [...otherKeys] } })
          .select('key displayName type')
          .lean()
      : Promise.resolve([]),
    otherKeys.size
      ? Organization.find({ key: { $in: [...otherKeys] } })
          .select('key displayName')
          .lean()
      : Promise.resolve([]),
  ]);
  const displayByKey = new Map<string, { displayName: string; type: string | null }>();
  for (const e of entityRows) {
    displayByKey.set(e.key as string, {
      displayName: (e.displayName as string | undefined) || (e.key as string),
      type: (e.type as string | undefined) ?? null,
    });
  }
  for (const o of orgRows) {
    if (!displayByKey.has(o.key as string)) {
      displayByKey.set(o.key as string, {
        displayName: (o.displayName as string | undefined) || (o.key as string),
        type: 'organization',
      });
    }
  }

  // Hydrate evidence page slugs in one batch so the UI can link
  // each snippet back to its source without per-row round trips.
  const evidencePageIds = new Set<string>();
  for (const r of rows) {
    for (const e of (r.evidence as Array<{ userId: Types.ObjectId; pageId: Types.ObjectId }> | undefined) ?? []) {
      if (globalView || String(e.userId) === String(userId)) {
        evidencePageIds.add(String(e.pageId));
      }
    }
  }
  const pageRows = evidencePageIds.size
    ? await Page.find({
        _id: { $in: [...evidencePageIds] },
        userId,
      })
        .select('_id slug')
        .lean()
    : [];
  const slugByPageId = new Map(pageRows.map((p) => [String(p._id), p.slug as string]));

  // Shape rows so the UI renders one side per row regardless of
  // direction. `otherKey` is always the other endpoint; `direction`
  // tells the UI whether to use predicate.label or predicate.inverseLabel.
  const shaped = rows
    .map((r) => {
      const isSubject = r.fromKey === entity;
      const otherKey = isSubject ? (r.toKey as string) : (r.fromKey as string);
      const pred = predicateByKey(r.predicate as string);
      const display = displayByKey.get(otherKey);
      // Display-name fallback chain:
      //   1. Local Entity row (preferred — honours user's casing)
      //   2. Wikidata label stored on the relation row when local
      //      lookup misses (happens when toKey is a Q-ID)
      //   3. The raw key as a last resort.
      const storedDisplayName = isSubject
        ? (r.toDisplayName as string | undefined)
        : (r.fromDisplayName as string | undefined);
      return {
        _id: String(r._id),
        predicate: r.predicate as string,
        predicateLabel: isSubject
          ? pred?.label ?? r.predicate
          : pred?.inverseLabel ?? pred?.label ?? r.predicate,
        direction: isSubject ? 'outgoing' : 'incoming',
        otherKey,
        otherDisplayName:
          display?.displayName ?? storedDisplayName ?? otherKey,
        otherType: display?.type ?? null,
        confidence: r.confidence,
        // Source flag — drives the UI badge. 'wikidata' = public
        // knowledge sourced from SPARQL; 'archive' = surfaced by
        // an LLM extractor over the user's pages.
        source: r.wikidataConfirmed ? 'wikidata' : 'archive',
        evidenceCount: ((r.evidence as Array<unknown> | undefined) ?? []).length,
        // Evidence from THIS user only, so we don't leak other
        // users' page slugs across the boundary.
        evidence: ((r.evidence as Array<{
          userId: Types.ObjectId;
          pageId: Types.ObjectId;
          snippet: string;
          extractedAt: Date;
        }> | undefined) ?? [])
          .filter((e) => globalView || String(e.userId) === String(userId))
          .slice(0, 5)
          .map((e) => ({
            pageId: String(e.pageId),
            pageSlug: slugByPageId.get(String(e.pageId)) ?? null,
            snippet: e.snippet ?? '',
            extractedAt: e.extractedAt
              ? new Date(e.extractedAt).toISOString()
              : null,
          })),
      };
    })
    // Defensive: drop rows whose predicate has been REMOVED from
    // the vocabulary (vs deprecated — deprecated still resolves).
    .filter((r) => !!predicateByKey(r.predicate));
  res.json({ relations: shaped });
});
