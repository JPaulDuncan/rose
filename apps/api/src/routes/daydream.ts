import { Router } from 'express';
import { Types } from 'mongoose';
import { User, DaydreamNote, Page, Sender, Entity } from '@rose/db';

/**
 * Plan 15 — resolve a list of userIds to `{id → displayName}` for
 * "contributed by" attribution on globally-shared records. Cheap
 * enough to call inline (one $in query); cap at 100 ids per call
 * since we only ever attribute one user per row today.
 */
async function displayNamesFor(
  userIds: (Types.ObjectId | null | undefined)[],
): Promise<Record<string, string>> {
  const unique = [
    ...new Set(
      userIds
        .filter((u): u is Types.ObjectId => !!u)
        .map((u) => String(u)),
    ),
  ];
  if (unique.length === 0) return {};
  const users = await User.find({ _id: { $in: unique } })
    .select('displayName')
    .lean();
  const out: Record<string, string> = {};
  for (const u of users) {
    out[String(u._id)] = u.displayName ?? '';
  }
  return out;
}
import { DaydreamSettings, DaydreamSettingsUpdate } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { encryptJson } from '../lib/crypto.js';

export const daydreamRouter: Router = Router();

/**
 * Read the user's daydream settings. Defaults the response through
 * the Zod parse so a user that's never opened the page sees the
 * documented defaults instead of `undefined` everywhere.
 *
 * The Brave subscription key (when set) is masked: the response
 * carries `externalSearch.brave.hasApiKey: boolean` instead of the
 * encrypted blob so the UI can show "key on file" without the value
 * ever leaving the server. Same convention as Anthropic/OpenAI keys
 * in /api/providers.
 */
daydreamRouter.get('/', async (req, res) => {
  const userId = userIdOf(req);
  // `+<hidden>` includes a `select: false` field on top of every
  // default-selected field, so the full doc (including
  // settings.daydream as a whole) comes back without us having to
  // also list the parent path. Listing both the parent AND the
  // child trips MongoDB's "Path collision" projection guard
  // (server error 31249).
  const user = await User.findById(userId)
    .select('+settings.daydream.externalSearch.brave.encryptedApiKey')
    .lean();
  const cfg = (user?.settings as { daydream?: Record<string, unknown> } | undefined)
    ?.daydream ?? {};
  // Translate `encryptedApiKey` → `hasApiKey` before zod parse.
  const ext = (cfg as { externalSearch?: Record<string, unknown> }).externalSearch;
  if (ext) {
    const brave = (ext as { brave?: { encryptedApiKey?: string | null } }).brave;
    if (brave) {
      (ext as { brave: { hasApiKey: boolean } }).brave = {
        ...(brave as Record<string, unknown>),
        hasApiKey: !!brave.encryptedApiKey,
      } as { hasApiKey: boolean };
      delete (ext as { brave: { encryptedApiKey?: unknown } }).brave.encryptedApiKey;
    }
  }
  const safe = DaydreamSettings.parse(cfg);
  res.json(safe);
});

/**
 * Patch — deep-merges `sources.*`, `skip.*`, and `externalSearch.*`
 * so a partial save (just toggling one knob) doesn't blow away the
 * rest of the config.
 *
 * `externalSearch.brave.apiKey` is write-only: a non-empty string
 * encrypts and stores; `null` clears; omitting leaves untouched.
 */
daydreamRouter.patch('/', validateBody(DaydreamSettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof DaydreamSettingsUpdate._type;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'sources' || k === 'skip' || k === 'externalSearch') continue;
    update[`settings.daydream.${k}`] = v;
  }
  if (body.sources) {
    for (const [k, v] of Object.entries(body.sources)) {
      update[`settings.daydream.sources.${k}`] = v;
    }
  }
  if (body.skip) {
    for (const [k, v] of Object.entries(body.skip)) {
      update[`settings.daydream.skip.${k}`] = v;
    }
  }
  if (body.externalSearch) {
    const ext = body.externalSearch;
    if (ext.enabled !== undefined) {
      update['settings.daydream.externalSearch.enabled'] = ext.enabled;
    }
    if (ext.marginalia)
      update['settings.daydream.externalSearch.marginalia'] = ext.marginalia;
    if (ext.duckduckgo)
      update['settings.daydream.externalSearch.duckduckgo'] = ext.duckduckgo;
    if (ext.brave) {
      const { apiKey, enabled } = ext.brave;
      if (enabled !== undefined) {
        update['settings.daydream.externalSearch.brave.enabled'] = enabled;
      }
      if (apiKey === null) {
        update['settings.daydream.externalSearch.brave.encryptedApiKey'] = null;
      } else if (typeof apiKey === 'string' && apiKey.length > 0) {
        update['settings.daydream.externalSearch.brave.encryptedApiKey'] = encryptJson({
          v: apiKey,
        });
      }
    }
    if (ext.searxng)
      update['settings.daydream.externalSearch.searxng'] = ext.searxng;
  }
  await User.findByIdAndUpdate(userId, { $set: update });
  res.json({ ok: true });
});

/**
 * Build the user's "interest set" — the (kind, subjectKey) pairs
 * the daydream layer should consider relevant to them. The set is
 * the union of:
 *
 *   • every entry on `Page.daydreamSubjects` across the user's
 *     pages (the worker's own canonical interest record — populated
 *     as data flows through the page-write pipeline),
 *   • every brandKey on this user's `Sender` rows (kind=sender),
 *   • every key on this user's `Entity` rows (kind=entity).
 *
 * Notes about subjects in this set are "aligned" with the user;
 * everything else is foreign-research that another user generated
 * and we don't surface. The user can override with `?all=true` to
 * inspect the global pool from Settings → Daydream.
 *
 * Subject keys are normalised the same way the worker writes them
 * (`daydreamSubjectKey` — lowercased, whitespace-collapsed) so a
 * pure $in lookup is enough.
 */
async function userInterestSet(
  userId: Types.ObjectId,
): Promise<{ keys: Set<string>; cap: boolean }> {
  // 1. Page.daydreamSubjects — pre-computed by the worker.
  // 2. Sender.brandKey — kind=sender.
  // 3. Entity.key — kind=entity (display key matches subjectKey for entities
  //    extracted via daydreamSubjectKey).
  // Capped to 5_000 distinct interests per user so a power user
  // doesn't blow up the $in. The cap is conservative; in practice
  // most users have a few hundred at most.
  const CAP = 5_000;
  const keys = new Set<string>();
  const dsRows = await Page.aggregate<{ _id: { kind: string; subjectKey: string } }>([
    { $match: { userId } },
    { $unwind: '$daydreamSubjects' },
    {
      $group: {
        _id: {
          kind: '$daydreamSubjects.kind',
          subjectKey: '$daydreamSubjects.subjectKey',
        },
      },
    },
    { $limit: CAP },
  ]);
  for (const r of dsRows) {
    if (r._id?.kind && r._id.subjectKey) {
      keys.add(`${r._id.kind}__${r._id.subjectKey}`);
    }
  }
  if (keys.size < CAP) {
    const senderRows = await Sender.find({ userId })
      .select('brandKey')
      .limit(CAP - keys.size)
      .lean();
    for (const s of senderRows) {
      if (s.brandKey) keys.add(`sender__${(s.brandKey as string).toLowerCase()}`);
    }
  }
  if (keys.size < CAP) {
    const entityRows = await Entity.find({ userId })
      .select('key displayName')
      .limit(CAP - keys.size)
      .lean();
    for (const e of entityRows) {
      // Entities use the lowercased displayName form for the
      // subjectKey, NOT the kebab `key`. Match what the daydream
      // worker writes so we hit the right notes.
      const display = (e.displayName as string | undefined) ?? '';
      const subjectKey = display.trim().toLowerCase().replace(/\s+/g, ' ');
      if (subjectKey) keys.add(`entity__${subjectKey}`);
    }
  }
  return { keys, cap: keys.size >= CAP };
}

/**
 * Recent daydream activity for the Settings page — a chronological
 * log so the user can see what daydream is doing without reading
 * worker logs. Notes are stored globally (Plan 14); this endpoint
 * surfaces only the ones aligned with the user's interest set so
 * they don't see foreign-research from subjects they have nothing
 * in common with.
 *
 * Query flags:
 *   • ?all=true — bypass alignment and show every note in the
 *     global pool (still hides ones the user has forgotten).
 *     Useful for debugging from Settings → Daydream.
 */
daydreamRouter.get('/recent', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const showAll = (req.query.all ?? '') === 'true';
  let interestKeys: Set<string> | null = null;
  if (!showAll) {
    const { keys } = await userInterestSet(userId);
    interestKeys = keys;
  }
  // Pull a generous over-fetch so client-side alignment filtering
  // still returns `limit` rows when the user's interest set is
  // narrower than the global pool's recent activity.
  const overFetch = showAll ? limit : Math.min(limit * 8, 500);
  const candidates = await DaydreamNote.find({ forgottenBy: { $ne: userId } })
    .sort({ generatedAt: -1 })
    .limit(overFetch)
    .lean();
  const notes = !interestKeys
    ? candidates
    : candidates
        .filter((n) =>
          interestKeys!.has(`${n.kind}__${(n.subjectKey as string).toLowerCase()}`),
        )
        .slice(0, limit);
  // Plan 15 — resolve `firstResearchedBy` to a display name so the
  // UI can render a "contributed by …" chip alongside each note.
  const names = await displayNamesFor(
    notes.map((n) => n.firstResearchedBy as Types.ObjectId | null),
  );
  res.json({
    aligned: !showAll,
    notes: notes.map((n) => ({
      _id: String(n._id),
      kind: n.kind,
      subjectKey: n.subjectKey,
      displayName: n.displayName,
      summary: n.summary,
      sources: (n.sources ?? []).map((s) => ({
        adapter: s.adapter,
        url: s.url,
        title: s.title ?? '',
      })),
      confidence: n.confidence,
      model: n.model ?? null,
      generatedAt: n.generatedAt ? n.generatedAt.toISOString() : null,
      failed: !!n.failed,
      failureReason: n.failureReason ?? null,
      contributedBy: n.firstResearchedBy
        ? names[String(n.firstResearchedBy)] ?? ''
        : '',
    })),
  });
});

/**
 * "Forget" one note for the current user. Plan 14 — notes are
 * shared, so this is a per-user mute (`$addToSet` on `forgottenBy`)
 * rather than a global delete. Any other user's refresh resurfaces
 * the note for them; the muted user has to wait for the next
 * successful refresh from any user (which clears forgottenBy worker-
 * side) to see it again.
 */
daydreamRouter.delete('/notes/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
    return;
  }
  const r = await DaydreamNote.updateOne(
    { _id: new Types.ObjectId(id) },
    { $addToSet: { forgottenBy: userId } },
  );
  res.json({ ok: true, hidden: (r.modifiedCount ?? 0) > 0 });
});
