import mongoose, { type Connection } from 'mongoose';

/**
 * Schema-sync + one-shot data migrations for the worker.
 *
 * Two layers:
 *
 *   1. `syncAllIndexes()` — idempotent, runs every boot. Iterates
 *      every registered Mongoose model and calls `model.syncIndexes()`,
 *      which both creates indexes declared in the schema that aren't
 *      yet on the collection AND drops indexes on the collection that
 *      aren't in the schema anymore. MongoDB 4.2+ runs createIndex in
 *      the background by default so this is safe to call against
 *      large collections without blocking writes.
 *
 *   2. `runMigrations()` — ordered, tracked. For one-shot data
 *      migrations (backfills, schema-version bumps that need code,
 *      anything that isn't just an index change). Each migration runs
 *      at most once per database; the `_migrations` collection records
 *      which have completed.
 *
 * Both should run from one place in the topology — either the single
 * `all` worker or the `bg` worker in split mode. MongoDB's createIndex
 * is internally synchronised so concurrent calls are correct, but
 * running migrations from one process keeps the logs sane and avoids
 * wasted work.
 */

const MIGRATIONS_COLLECTION = '_migrations';

export type SyncIndexResult = {
  models: string[];
  dropped: Record<string, string[]>;
  created: Record<string, number>;
  failed: { model: string; error: string }[];
};

/**
 * Reconcile every registered model's indexes against its live
 * collection. Picks up schema-side index additions on existing
 * deployments — without this, the indexes added in
 * commit `09d823c` would only attach to fresh collections and
 * never to a running production database.
 *
 * Failures on individual models are caught + reported so a single
 * misconfigured collection (e.g. a duplicate-key violation when a
 * unique index can't apply) doesn't block the rest of the sweep.
 */
export async function syncAllIndexes(
  conn: Connection = mongoose.connection,
): Promise<SyncIndexResult> {
  const models = Object.keys(conn.models);
  const result: SyncIndexResult = {
    models: [],
    dropped: {},
    created: {},
    failed: [],
  };
  for (const name of models) {
    const m = conn.model(name);
    try {
      // Snapshot indexes before so we can report what got created.
      const before = await m.collection.indexes().catch(() => [] as { name?: string }[]);
      const dropped = await m.syncIndexes();
      const after = await m.collection.indexes().catch(() => [] as { name?: string }[]);
      const beforeNames = new Set(before.map((x) => x.name).filter(Boolean) as string[]);
      const createdCount = after.filter((x) => x.name && !beforeNames.has(x.name)).length;
      result.models.push(name);
      if (dropped.length > 0) result.dropped[name] = dropped;
      if (createdCount > 0) result.created[name] = createdCount;
    } catch (err) {
      result.failed.push({
        model: name,
        error: (err as Error).message,
      });
    }
  }
  return result;
}

/**
 * One-shot data migration definition. `name` is the unique key
 * stored in `_migrations`; once `run()` completes, it never runs
 * again on the same database. Order matters when migrations depend
 * on prior ones — they execute in array order.
 */
export type Migration = {
  name: string;
  run(conn: Connection): Promise<void>;
};

/**
 * Registry of migrations. Add new entries to the bottom — never
 * reorder or rename existing ones (the name is the dedup key).
 *
 * Empty for now; index sync is handled by `syncAllIndexes()` and
 * doesn't need a migration entry. Future entries (Float32 embedding
 * encoding, body-collection split, etc.) will land here.
 */
const MIGRATIONS: Migration[] = [
  {
    // Backfill the global Organization collection from existing
    // per-user Entity rows of type='organization'. Before this
    // migration, organizations only lived on per-user Entity rows;
    // the new Organization collection is the canonical source for
    // the shared name + aliases. Idempotent via `key` upserts:
    // re-running aggregates aliases via $addToSet without
    // overwriting any user's later edit.
    name: '2026-05-09-backfill-organizations',
    async run(conn) {
      const entities = conn.collection('entities');
      const orgs = conn.collection('organizations');
      const cursor = entities.find(
        { type: 'organization' },
        { projection: { key: 1, displayName: 1, aliases: 1, userId: 1 } },
      );
      while (await cursor.hasNext()) {
        const ent = await cursor.next();
        if (!ent) continue;
        const key = String(ent.key ?? '').trim();
        if (!key) continue;
        const displayName = String(ent.displayName ?? key);
        const aliases = Array.isArray(ent.aliases)
          ? (ent.aliases as unknown[]).map(String).filter(Boolean)
          : [];
        const set: Record<string, unknown> = {
          $setOnInsert: {
            key,
            displayName,
            firstSeenBy: ent.userId ?? null,
            createdAt: new Date(),
          },
          $set: { updatedAt: new Date() },
        };
        if (aliases.length) {
          set.$addToSet = { aliases: { $each: aliases } };
        }
        await orgs.updateOne({ key }, set, { upsert: true });
      }
    },
  },
  {
    // Convert per-user LibraryDocument rows into the new
    // global-doc + per-user-ref split. For every legacy row:
    //   1. upsert one global LibraryDocument keyed on urlHash
    //      ($setOnInsert keeps the first user's body wins),
    //   2. create the per-user LibraryDocumentRef that points
    //      at the resulting global doc and remembers the user's
    //      sourceId,
    //   3. delete the legacy row.
    // Idempotent: Refs use (userId, documentId) unique upsert,
    // and the legacy delete is a no-op once the row is gone. Safe
    // to re-run if interrupted.
    name: '2026-05-09-globalise-library-documents',
    async run(conn) {
      const docs = conn.collection('librarydocuments');
      const refs = conn.collection('librarydocumentrefs');
      // Pre-create the global unique index — the legacy collection
      // had a (userId, urlHash) compound unique that would block
      // writes if two rows for the same URL exist across users.
      // Drop the old index by name if present; ignore errors when
      // the index doesn't exist (fresh DBs, re-runs).
      try {
        await docs.dropIndex('userId_1_urlHash_1');
      } catch {
        // not present — fine.
      }

      const cursor = docs.find(
        { userId: { $exists: true } },
        {
          projection: {
            _id: 1,
            userId: 1,
            sourceId: 1,
            url: 1,
            urlHash: 1,
            title: 1,
            author: 1,
            publishedAt: 1,
            summary: 1,
            bodyText: 1,
            tags: 1,
            topics: 1,
            embedding: 1,
            embeddingModel: 1,
            crawledAt: 1,
            staleAfter: 1,
            createdAt: 1,
          },
        },
      );
      while (await cursor.hasNext()) {
        const row = await cursor.next();
        if (!row) continue;
        const urlHash = String(row.urlHash ?? '');
        if (!urlHash) {
          // Old test/garbage row — skip.
          continue;
        }
        // Upsert the canonical global doc. setOnInsert wins for
        // first-discovered fields; later runs add to tags via
        // $addToSet so we don't lose category data from a
        // duplicate user's row.
        const update: Record<string, unknown> = {
          $setOnInsert: {
            urlHash,
            url: row.url ?? '',
            title: row.title ?? '',
            author: row.author ?? '',
            publishedAt: row.publishedAt ?? null,
            summary: row.summary ?? '',
            bodyText: row.bodyText ?? '',
            topics: Array.isArray(row.topics) ? row.topics : [],
            embedding: Array.isArray(row.embedding) ? row.embedding : null,
            embeddingModel: row.embeddingModel ?? null,
            crawledAt: row.crawledAt ?? new Date(),
            staleAfter: row.staleAfter ?? null,
            firstSeenBy: row.userId ?? null,
            firstSourceId: row.sourceId ?? null,
            createdAt: row.createdAt ?? new Date(),
          },
          $set: { updatedAt: new Date() },
        };
        if (Array.isArray(row.tags) && row.tags.length > 0) {
          update.$addToSet = { tags: { $each: row.tags } };
        }
        const upserted = await docs.findOneAndUpdate(
          { urlHash },
          update,
          { upsert: true, returnDocument: 'after' },
        );
        const globalDocId = upserted?._id ?? row._id;

        // Per-user ref: idempotent upsert on (userId, documentId).
        await refs.updateOne(
          { userId: row.userId, documentId: globalDocId },
          {
            $setOnInsert: {
              userId: row.userId,
              documentId: globalDocId,
              sourceId: row.sourceId ?? null,
              addedAt: row.crawledAt ?? new Date(),
              archivedAt: null,
              readAt: null,
              userTags: [],
              userNote: '',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );

        // Legacy row absorbed; delete it unless it IS the canonical
        // upserted row (in which case findOneAndUpdate kept the same
        // _id and we just need to strip the userId/sourceId fields).
        if (String(row._id) !== String(globalDocId)) {
          await docs.deleteOne({ _id: row._id });
        } else {
          await docs.updateOne(
            { _id: row._id },
            { $unset: { userId: '', sourceId: '' } },
          );
        }
      }
    },
  },
  {
    // Collapse per-user TagCanonical rows into the global registry.
    // Each (userId, canonical) row becomes one shared (canonical)
    // row keyed on the kebab. First-seen displayName wins; aliases
    // accumulate via $addToSet so every user's discoveries
    // contribute. The legacy (userId, canonical) compound unique
    // index is dropped — the new schema enforces a global unique on
    // canonical alone.
    name: '2026-05-09-globalise-tag-canonicals',
    async run(conn) {
      const tags = conn.collection('tagcanonicals');
      try {
        await tags.dropIndex('userId_1_canonical_1');
      } catch {
        // Not present — first-run on this DB or already dropped.
      }
      const cursor = tags.find(
        { userId: { $exists: true } },
        {
          projection: {
            _id: 1,
            userId: 1,
            canonical: 1,
            displayName: 1,
            aliases: 1,
            pageCount: 1,
            createdAt: 1,
          },
        },
      );
      while (await cursor.hasNext()) {
        const row = await cursor.next();
        if (!row) continue;
        const canonical = String(row.canonical ?? '').trim();
        if (!canonical) continue;
        const aliases = Array.isArray(row.aliases)
          ? (row.aliases as unknown[]).map(String).filter(Boolean)
          : [];
        const update: Record<string, unknown> = {
          $setOnInsert: {
            canonical,
            displayName: String(row.displayName ?? '') || canonical,
            firstSeenBy: row.userId ?? null,
            createdAt: row.createdAt ?? new Date(),
          },
          $set: { updatedAt: new Date() },
          $inc: { pageCount: Number(row.pageCount ?? 0) },
        };
        if (aliases.length) {
          update.$addToSet = { aliases: { $each: aliases } };
        }
        const upserted = await tags.findOneAndUpdate(
          { canonical },
          update,
          { upsert: true, returnDocument: 'after' },
        );
        const globalId = upserted?._id ?? row._id;
        if (String(row._id) !== String(globalId)) {
          // A different row already owned this canonical; drop the
          // legacy duplicate. We've already folded its aliases /
          // pageCount above.
          await tags.deleteOne({ _id: row._id });
        } else {
          // Same row — strip the now-vestigial userId field.
          await tags.updateOne(
            { _id: row._id },
            { $unset: { userId: '' } },
          );
        }
      }
    },
  },
];

export async function runMigrations(
  conn: Connection = mongoose.connection,
): Promise<{ applied: string[]; skipped: string[] }> {
  const collection = conn.collection(MIGRATIONS_COLLECTION);
  // Unique on `name` so a concurrent runner can't double-apply.
  // Idempotent — re-creates the index if it doesn't exist.
  await collection.createIndex({ name: 1 }, { unique: true });
  const existing = await collection.find({}, { projection: { name: 1 } }).toArray();
  const appliedSet = new Set(existing.map((d) => String(d.name)));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.name)) {
      skipped.push(m.name);
      continue;
    }
    await m.run(conn);
    // Insert the marker only after `run` returns. If the migration
    // throws, the marker is never written and the next boot will
    // retry — which is what we want for recoverable failures, and
    // a hard requirement for "never silently skip a failed
    // migration" hygiene.
    await collection.insertOne({ name: m.name, appliedAt: new Date() });
    applied.push(m.name);
  }
  return { applied, skipped };
}
