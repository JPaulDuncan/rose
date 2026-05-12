import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Global product registry. One row per product (e.g. "MacBook Pro
 * 14-inch 2023") shared across users, like SenderBrand /
 * Organization / TagCanonical. Per-user purchase history lives on
 * `ProductPurchase`; the canonical name + manufacturer + summary
 * + best-known image is here so user A's receipt for the same
 * item benefits from user B's prior extraction.
 *
 * `slugKey` is the lookup key — kebab-cased canonical name. The
 * extractor lowercases + collapses non-alphanumerics the same way
 * `normalizeTagKey` does, then `$setOnInsert`-uses the first
 * extraction's name as the canonical surface form.
 */
const productSchema = new Schema(
  {
    /** Stable kebab lookup key. Globally unique. */
    slugKey: { type: String, required: true, unique: true, index: true },
    /** Canonical surface form. First-seen-wins via $setOnInsert. */
    name: { type: String, required: true, maxlength: 200 },
    /** Optional manufacturer / brand name, e.g. "Apple". */
    manufacturer: { type: String, default: null, maxlength: 120 },
    /** Optional SKU / model number for hard-good products. */
    modelNumber: { type: String, default: null, maxlength: 80 },
    /** Coarse category for the spending-dashboard rollups. */
    category: {
      type: String,
      enum: [
        'food',
        'electronics',
        'clothing',
        'home',
        'media',
        'service',
        'travel',
        'health',
        'office',
        'other',
        null,
      ],
      default: null,
      index: true,
    },
    /** LLM-written 1-paragraph "what is this product" brief.
     *  Filled lazily by a background pass; null until then. */
    summary: { type: String, default: '' },
    summaryGeneratedAt: { type: Date, default: null },
    summaryModel: { type: String, default: null },
    /** Best-known image URL. Reuse the brand-chip pattern: any
     *  user's receipt that includes a product image teaches every
     *  other user's view. */
    imageUrl: { type: String, default: null },
    /** Audit — first user whose receipt minted the row. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Wikidata Q-ID when the ontology resolver pinned this
     *  product to a canonical external entry. Same shape as on
     *  Organization. */
    wikidataId: { type: String, default: null, index: true, maxlength: 16 },
    wikidataConfidence: { type: Number, default: 0 },
    wikidataResolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

productSchema.index({ name: 'text', manufacturer: 'text' });

export type ProductDoc = HydratedDocument<InferSchemaType<typeof productSchema>> & {
  _id: Types.ObjectId;
};
export const Product = model('Product', productSchema);
