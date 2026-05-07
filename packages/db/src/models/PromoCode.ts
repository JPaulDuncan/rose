import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const promoCodeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The literal code as the user would paste it. Stored case-preserved
     *  so "FREESHIP" and "freeship" stay distinguishable when the merchant
     *  is case-sensitive. */
    code: { type: String, required: true, maxlength: 60, index: true },
    /** Sender's brand key (e.g. "amctheatres") — what we use to dedupe
     *  and display. Falls back to the from-domain when there's no brand. */
    brand: { type: String, default: null, index: true },
    /** Display name for the brand (from SenderBrand) — populated when
     *  the extractor ran with a sender lookup; used as the row label. */
    brandLabel: { type: String, default: null },
    /** One-sentence description from the email near the code, e.g.
     *  "Save 20% on your next order with code SAVE20." */
    description: { type: String, default: '', maxlength: 500 },
    /** Parsed discount phrase from the description, e.g. "20% off",
     *  "$10 off", "free shipping". Best-effort. */
    discount: { type: String, default: null, maxlength: 80 },
    /** Parsed expiration date when the email mentions one. */
    expiresAt: { type: Date, default: null, index: true },
    /** Optional redemption URL pulled from a nearby anchor. */
    url: { type: String, default: null, maxlength: 2000 },
    /** Source email — back-reference for "open the source". */
    emailId: { type: Schema.Types.ObjectId, ref: 'Email', required: true, index: true },
    /** Optional page back-reference if the email already produced an
     *  article. Lets the UI link back to the full story. */
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', default: null },
    /** User-marked "I used this". Visible in the UI as a strike-through;
     *  filterable so the page focuses on still-redeemable codes. */
    usedAt: { type: Date, default: null },
    /** Soft archive — codes the user wants to hide from the active list
     *  without deleting (mirrors Email.archivedAt). */
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Dedupe by (user, code, brand) — two different brands can legitimately
// run the same generic code (e.g. "SAVE20").
promoCodeSchema.index(
  { userId: 1, code: 1, brand: 1 },
  { unique: true, partialFilterExpression: { brand: { $type: 'string' } } },
);
// Fallback dedupe for codes with no brand.
promoCodeSchema.index(
  { userId: 1, code: 1 },
  { unique: true, partialFilterExpression: { brand: null } },
);

export type PromoCodeDoc = HydratedDocument<InferSchemaType<typeof promoCodeSchema>> & {
  _id: Types.ObjectId;
};
export const PromoCode = model('PromoCode', promoCodeSchema);
