import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Per-user record of buying one product on one receipt. Pages
 * (receipts) are per-user, so the purchase log is too — but it
 * points at the GLOBAL Product row so the canonical name +
 * manufacturer + summary stay shared.
 *
 * Idempotency: `(userId, productId, pageId)` is unique. The
 * receipt extractor can be re-run on the same page without
 * duplicating the purchase row. Re-extraction does $set the
 * amount + purchasedAt in case the LLM revises them.
 */
const purchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    /** The Page that holds the receipt body. Links back so the
     *  product page can show "purchased on 12 Dec — see receipt". */
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true, index: true },
    /** Originating Email row, when known. Receipts that were
     *  uploaded manually (no email) leave this null. */
    emailId: { type: Schema.Types.ObjectId, ref: 'Email', default: null },
    /** Merchant brand-key (resolves to SenderBrand). Drives the
     *  brand chip on the product page. Null for non-email
     *  receipts. */
    merchantBrandKey: { type: String, default: null, index: true },
    /** Line-item amount in the receipt's currency. */
    amount: { type: Number, default: null },
    /** ISO 4217 currency code, uppercase. */
    currency: { type: String, default: null, maxlength: 8 },
    /** Quantity purchased — defaults to 1 when the LLM doesn't
     *  call it out. */
    quantity: { type: Number, default: 1, min: 1, max: 10_000 },
    /** When the purchase was made. May differ from the email date
     *  (e.g. a shipping confirmation arrives days later). */
    purchasedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

purchaseSchema.index({ userId: 1, productId: 1, pageId: 1 }, { unique: true });
purchaseSchema.index({ userId: 1, purchasedAt: -1 });

export type ProductPurchaseDoc = HydratedDocument<InferSchemaType<typeof purchaseSchema>> & {
  _id: Types.ObjectId;
};
export const ProductPurchase = model('ProductPurchase', purchaseSchema);
