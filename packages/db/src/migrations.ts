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
