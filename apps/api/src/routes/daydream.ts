import { Router } from 'express';
import { Types } from 'mongoose';
import { User, DaydreamNote } from '@rose/db';

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
 * Recent daydream activity for the Settings page — a chronological
 * log so the user can see what daydream is doing without reading
 * worker logs. Plan 14 — notes are now globally shared, so this
 * lists everything the current user hasn't "forgotten" (sorted by
 * generatedAt). Failures with their reason stay surfaced.
 */
daydreamRouter.get('/recent', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const notes = await DaydreamNote.find({ forgottenBy: { $ne: userId } })
    .sort({ generatedAt: -1 })
    .limit(limit)
    .lean();
  // Plan 15 — resolve `firstResearchedBy` to a display name so the
  // UI can render a "contributed by …" chip alongside each note.
  const names = await displayNamesFor(
    notes.map((n) => n.firstResearchedBy as Types.ObjectId | null),
  );
  res.json({
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
