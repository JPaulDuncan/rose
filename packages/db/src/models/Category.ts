import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Normalize a free-text category name into a stable lookup key:
 * lowercase, collapse any run of non-alphanumerics into a single
 * space, trim. So "EMail Marketing", "email-marketing", and
 * "  email   marketing  " all map to "email marketing" — and the
 * Codex shows them as one chapter.
 */
export function normalizeCategoryName(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that stay lowercase when not the leading word — keeps
 *  "Tools and Apparel" out of "Tools And Apparel" territory. */
const TITLE_LOWER = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'vs',
  'with',
]);

export const UNCATEGORIZED_NAME = 'Uncategorized';

/**
 * Display-form for a category name. Categories are user-visible and
 * shouldn't read like URL slugs ("email-marketing"). The LLM is
 * inconsistent about capitalisation, so this normalises to Title
 * Case at write time + at render time. Hyphens / underscores fold
 * into spaces; empty input becomes the canonical "Uncategorized"
 * fallback so the UI never has to render a null badge.
 */
export function displayCategoryName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return UNCATEGORIZED_NAME;
  return cleaned
    .split(' ')
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && TITLE_LOWER.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Curated "desks" vs free-form "ad-hoc" categories. The desks model
 * the user's archive as newspaper sections (Local, National, Sports,
 * Dining, Advertising, …); the generator picks from this closed
 * vocabulary when it exists, falling back to ad-hoc emission only
 * when no desks are seeded yet (cold-start on legacy users).
 *
 * Existing categories migrate as `kind: 'ad-hoc'` because that's
 * what they actually are — the LLM invented them per-page. A
 * separate sweeper clusters those and proposes new desks
 * ("Suggest new desks" button on Settings → Desks).
 */
export const CATEGORY_KINDS = ['desk', 'ad-hoc'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_STATUSES = ['active', 'proposed', 'archived'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

const categorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Display name — what the user sees. Whatever the LLM emitted
     *  on the first occurrence (e.g. "Email Marketing"). */
    name: { type: String, required: true },
    /** Stable lookup key derived via `normalizeCategoryName`. New
     *  categories index on this so case/punctuation variants don't
     *  produce duplicate Category rows. */
    normalizedName: { type: String, default: '' },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    color: { type: String, default: null },
    icon: { type: String, default: null },
    /**
     * 'desk'   — curated newspaper-section vocabulary; the generator
     *            constrains its `suggestedCategory` output to these.
     * 'ad-hoc' — free-form category invented by the LLM (legacy
     *            v1 behaviour). The sweeper clusters these to
     *            propose new desks.
     * Default 'ad-hoc' so existing rows migrate as-is.
     */
    kind: { type: String, enum: CATEGORY_KINDS, default: 'ad-hoc', index: true },
    /**
     * One-line description fed into the generator's prompt so the
     * LLM knows what kinds of pages belong on this desk. Empty for
     * ad-hoc categories.
     */
    description: { type: String, default: '', maxlength: 280 },
    /**
     * True for seeded defaults (Local, National, Sports, …) so the
     * UI prevents deletion (only rename + archive). Cleared on
     * user-created desks.
     */
    seedDefault: { type: Boolean, default: false },
    /**
     * 'active'   — appears in the generator vocabulary + the UI.
     * 'proposed' — created by the sweeper, awaiting user accept.
     *              NOT shown to the generator.
     * 'archived' — soft-removed. Kept for audit; suppressed from
     *              the generator vocabulary AND the sidebar.
     */
    status: {
      type: String,
      enum: CATEGORY_STATUSES,
      default: 'active',
      index: true,
    },
    /**
     * Free-text reason a proposed desk was rejected. Persisted so
     * the sweeper can suppress re-proposing the same theme on the
     * next pass. Cleared when the user accepts an alternative.
     */
    rejectedReason: { type: String, default: null },
    /** Sample page titles the sweeper bundled with a proposal —
     *  rendered alongside the Accept / Reject buttons so the user
     *  can see why Rose thought a new desk was warranted. */
    proposalSamplePages: {
      type: [
        new Schema(
          {
            pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
            title: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

// Pre-existing installs may not have populated normalizedName yet, so
// the unique-on-name index stays as-is. New code paths upsert by
// `(userId, normalizedName)` and fall back to a name-equality check.
categorySchema.index({ userId: 1, name: 1 }, { unique: true });
categorySchema.index({ userId: 1, normalizedName: 1 });
categorySchema.index({ userId: 1, kind: 1, status: 1 });

export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = model('Category', categorySchema);

/**
 * Seed defaults — the newspaper-section vocabulary Rose ships with.
 * `ensureDeskSeedsForUser` creates these idempotently the first time
 * a user generates a page after this feature lands.
 *
 * Descriptions are deliberately concrete so the generator's LLM has
 * unambiguous "what belongs on this desk" guidance. The names are
 * Title Case (matching `displayCategoryName`'s convention).
 */
export const DESK_SEED_DEFAULTS: readonly {
  name: string;
  description: string;
  icon: string;
}[] = [
  {
    name: 'Local',
    description:
      'Local events, businesses, services, government, and people in the area where the user lives.',
    icon: 'MapPin',
  },
  {
    name: 'National',
    description:
      "Country-level news, politics, policy, infrastructure, and culture stories — anything that's national but not specifically local to the user.",
    icon: 'Flag',
  },
  {
    name: 'Sports',
    description:
      'Games, athletes, teams, scores, tournaments, sports media, and the business of sports.',
    icon: 'Trophy',
  },
  {
    name: 'Weather',
    description:
      'Forecasts, severe weather alerts, storm updates, climate news, and atmospheric phenomena.',
    icon: 'CloudSun',
  },
  {
    name: 'Horoscope',
    description:
      'Astrology, daily/weekly zodiac readings, astronomical events, and related esoterica.',
    icon: 'Sparkles',
  },
  {
    name: 'Adventures',
    description:
      'Travel destinations, trip planning, hiking, camping, road trips, and outdoor activities.',
    icon: 'Mountain',
  },
  {
    name: 'Dining',
    description:
      'Restaurants, recipes, food delivery, cookware, drinks, food media, and culinary trends.',
    icon: 'Utensils',
  },
  {
    name: 'Advertising',
    description:
      'Promotional emails, marketing campaigns, sales, deals, coupon codes, and sponsored content. Auto-assigned when a page is flagged promotional.',
    icon: 'Megaphone',
  },
  {
    name: UNCATEGORIZED_NAME,
    description:
      'Pages that do not fit any other desk. The generator should only land here when no desk reasonably applies.',
    icon: 'Inbox',
  },
];
