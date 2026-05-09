import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Global brand-level information about a sender. Plan 14 — the
 * pre-existing `Sender` collection mixed brand-global facts (logo,
 * canonical name, websites referenced, the LLM-written brief) with
 * per-user state (counts, toggles, last-seen). The brand-global
 * fields cost an LLM call apiece per user to learn; consolidating
 * them on a shared collection means whoever first pays the cost
 * teaches everyone else.
 *
 * Reads merge `SenderBrand` (this collection) with the per-user
 * `Sender` row when both exist. Writes route accordingly: any
 * field that Rose can learn from public signals (favicon for
 * domain, sender's own marketing URLs, the LLM brief) goes here;
 * anything tied to a user's behavior (email counts, spam-mark
 * threshold, stripAds toggle) stays on the per-user row.
 *
 * `forgottenBriefBy[]` mirrors `DaydreamNote.forgottenBy` — a user
 * can hide the brief from their own views without deleting the
 * shared row. There's no per-user "forget the logo" affordance;
 * the logo is either correct or the user uploads their own
 * (which we'd handle via a future per-user override field —
 * not in scope today).
 */
const brandSchema = new Schema(
  {
    /** Stable lookup key — the lowercase second-level-domain label
     *  for true brands (`medium` for `medium.com`), or the
     *  `local@domain` form for personal-mail brands so each
     *  individual contact gets a distinct row. Matches what
     *  `Sender.brandKey` has always been. */
    brandKey: { type: String, required: true, unique: true, index: true },
    /** Primary domain. null for personal-mail brands. */
    domain: { type: String, default: null, index: true },
    /** Display name. Brand-cased domain by default ("Medium"); the
     *  LLM brief or the user's manual edits can override. */
    name: { type: String, default: '' },
    /** Every email address any user has seen for this brand. */
    addresses: { type: [String], default: [], index: true },
    /** Every link domain referenced from any user's mail with this
     *  brand. Useful for the codex / address-book view. */
    websites: { type: [String], default: [] },
    /** Best logo URL we've learned + confidence. Plan 14 — also
     *  the source-of-truth that the page-rail brand chips read
     *  from, so a logo learned from one user's email shows for
     *  every user encountering the same sender. */
    logoUrl: { type: String, default: null },
    logoConfidence: { type: Number, default: 0 },
    /** Unsubscribe URLs gathered from List-Unsubscribe headers /
     *  body links across users' mail. Capped at 4 to prevent a
     *  bad header parser from flooding the array. */
    unsubscribeUrls: { type: [String], default: [] },
    /** Postal addresses parsed from email footers, deduped. */
    postalAddresses: { type: [String], default: [] },
    /** LLM-written 1-paragraph "who is this" brief. Plan 14 — this
     *  is the sender wiki page's body. Generated once per brand
     *  globally; refresh queues from any user's UI hit the same
     *  row. */
    summary: { type: String, default: '' },
    summaryGeneratedAt: { type: Date, default: null },
    summaryModel: { type: String, default: null },
    /** Users who've explicitly forgotten the brief. Per-user mute
     *  rather than a global delete, so anyone else's refresh
     *  resurfaces. */
    forgottenBriefBy: { type: [Schema.Types.ObjectId], default: [], index: true },
    /** Audit-only: first user whose mail surfaced this brand. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Global spam blacklist (cross-user) ──────────────────────
    //
    // The user-facing rule is "once any user marks an item as spam,
    // it's marked as spam for ALL users; users can opt-in to receive
    // it anyway." Implemented at the brand level — that's the only
    // unit that translates across users (per-page marks don't, since
    // pages are per-user).
    //
    // `spamMarkedBy` / `rescuedBy` are user-id sets so a single user
    // can't run up the count by repeatedly marking the same brand.
    // `globalSpam` is denormalised from `spamMarkedBy.length >
    // rescuedBy.length` so the worker can filter on it cheaply.
    /** Users who explicitly marked any of this brand's mail spam. */
    spamMarkedBy: {
      type: [Schema.Types.ObjectId],
      ref: 'User',
      default: [],
      index: true,
    },
    /** Users who explicitly rescued / trusted the brand. Cancels a
     *  spam mark from the global tally. */
    rescuedBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    /** Denormalised flag: any net spam marks → globally flagged.
     *  Indexed so generatePage can fetch every flagged brand in
     *  one query. */
    globalSpam: { type: Boolean, default: false, index: true },
    /** When the brand first crossed the threshold. Used by the UI
     *  to sort "newly flagged" brands and by future audit reports. */
    firstFlaggedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type SenderBrandDoc = HydratedDocument<InferSchemaType<typeof brandSchema>> & {
  _id: Types.ObjectId;
};
export const SenderBrand = model('SenderBrand', brandSchema);
