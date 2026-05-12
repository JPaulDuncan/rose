import type { RecipeEventKind } from '../schemas/recipe.js';

/**
 * Pipeline catalog — declarative metadata about every event kind the
 * recipe dispatcher knows about. Powers the read-only "Pipeline" tab
 * in the Recipes settings page: users see at a glance which stages
 * of Rose emit hooks they can listen on, what each emit means, and
 * which workers consume the event internally.
 *
 * The catalog is intentionally static. We're not auto-discovering
 * emit sites — drift between code and catalog is easier to catch in
 * a one-line PR than in a self-introspecting registry that lies
 * when someone forgets to register. When a new emit lands, add a
 * row here in the same commit; the matcher tests fail-loud if a
 * RecipeEventKind isn't represented.
 *
 * The shape stays narrow on purpose: no payload schemas, no
 * trigger-config docs. Those belong on the schema itself
 * (`Trigger*` Zod definitions); duplicating them here would just
 * rot. The catalog is the meta-layer above the schemas: where in
 * Rose's pipeline does each event come from, and what does Rose
 * itself do with it.
 */

export type PipelineStage = {
  /** Event kind exactly as declared in the RecipeEventKind enum. */
  kind: RecipeEventKind;
  /** Short label rendered in the UI. Title-cased, no period. */
  label: string;
  /** One-paragraph description of when the event fires. */
  description: string;
  /**
   * Human-readable names of the worker/route that emits the event.
   * Used as the "emitted by" line. Avoid file paths — they rot;
   * names of the conceptual stage are stable.
   */
  emittedBy: string[];
  /**
   * Internal handlers that ALREADY consume this event today,
   * outside the user-recipe dispatcher. Most events have no
   * internal consumer (recipes are the only listener); the few
   * that do — e.g. email.ingested is consumed by the auto-tagger
   * — are called out so users understand a recipe is layering on
   * top of, not replacing, the built-in behaviour.
   */
  internalConsumers: { name: string; description: string }[];
  /**
   * Whether this kind was part of the original recipe surface
   * (Phase 1, true) or a newer addition (false). The Pipeline tab
   * highlights newer kinds with a "new" pill so returning users
   * notice the expanded surface.
   */
  shipped: 'phase-1' | 'phase-2';
};

export const PIPELINE_CATALOG: readonly PipelineStage[] = [
  {
    kind: 'email.ingested',
    label: 'Email ingested',
    description:
      'Fires once per new email row, immediately after the IMAP / Gmail / website-sync ingest path inserts it. Sender, subject, brand, priority, and the extracted topic tags are denormalised onto the event so most recipes can decide without re-querying.',
    emittedBy: ['IMAP sync', 'Gmail sync', 'Website sync (per-snapshot Email row)'],
    internalConsumers: [
      {
        name: 'Page assignment + generation',
        description:
          "The generate-page worker picks up every ingested email and either appends it to an existing page or starts a new one. Recipes can't disable this internal step — they layer on top of it.",
      },
      {
        name: 'Shipment detection',
        description:
          'Tracking-number scanning runs unconditionally. A separate `shipment.detected` event fires only when it finds something.',
      },
      {
        name: 'Promo-code detection',
        description:
          'Coupon scanning runs unconditionally; `promo.detected` fires when codes are found.',
      },
    ],
    shipped: 'phase-1',
  },
  {
    kind: 'page.created',
    label: 'Page created',
    description:
      'Fires after `generate-page` finishes synthesising a new Page. Tags, category, and contributing-sender brand keys are denormalised onto the event so condition matchers stay pure.',
    emittedBy: ['Generate-page worker'],
    internalConsumers: [
      {
        name: 'Embedding',
        description:
          'New pages get vectorised so the search + retrieval pipeline can use them.',
      },
      {
        name: 'Post-write hooks',
        description:
          'Entity extraction, daydream subject caching, and outbound-link indexing all run on page write.',
      },
    ],
    shipped: 'phase-1',
  },
  {
    kind: 'tag.applied',
    label: 'Tag applied',
    description:
      "Fires when a tag is added to a page — by the generator, by the canonicaliser, or by a user. Lets recipes say 'whenever something lands on #invoices, do X'.",
    emittedBy: ['Generate-page worker', 'Tag canonicaliser', 'API: PATCH /api/pages/:id'],
    internalConsumers: [
      {
        name: 'Tag-digest scheduler',
        description: 'Periodic digests can be subscribed-to per tag.',
      },
    ],
    shipped: 'phase-1',
  },
  {
    kind: 'time.scheduled',
    label: 'Scheduled (cron)',
    description:
      "Recipe-internal — fires on a cron pattern stored on the recipe itself. No worker emits this; BullMQ's repeatable scheduler delivers the event when the cron matches. Use for daily briefings, weekly summaries, etc.",
    emittedBy: ['BullMQ repeatable scheduler'],
    internalConsumers: [],
    shipped: 'phase-1',
  },
  {
    kind: 'subscription.created',
    label: 'Subscription detected (first time)',
    description:
      'Fires the first time the subscription extractor folds two or more matching receipts into a Subscription row. Carries service name, amount, cadence, and category for downstream filtering.',
    emittedBy: ['Subscription extractor'],
    internalConsumers: [],
    shipped: 'phase-1',
  },
  {
    kind: 'subscription.renewed',
    label: 'Subscription renewed',
    description:
      'Fires when an existing Subscription gets fresh evidence — typically a renewal receipt. Same payload as the created event; dedup key combines subscription ID + extractedAt so two receipts in one cycle never double-fire.',
    emittedBy: ['Subscription extractor'],
    internalConsumers: [],
    shipped: 'phase-1',
  },
  {
    kind: 'attachment.received',
    label: 'Attachment received',
    description:
      "Fires once per ingested email whose `attachments[]` is non-empty. The aggregate content-type and filename lists are on the event so a 'PDF from vendor' or 'image from anyone' filter doesn't need to re-load the row.",
    emittedBy: ['IMAP sync', 'Gmail sync'],
    internalConsumers: [],
    shipped: 'phase-2',
  },
  {
    kind: 'shipment.detected',
    label: 'Shipment detected',
    description:
      'Fires when the per-email shipment scanner finds at least one tracking number. Single event per detection-pass, with the aggregate count; most receipts produce count = 1.',
    emittedBy: ['IMAP sync', 'Gmail sync'],
    internalConsumers: [
      {
        name: 'Shipment registry',
        description: 'Detected tracking numbers also persist on the Shipment collection for the shipments view.',
      },
    ],
    shipped: 'phase-2',
  },
  {
    kind: 'promo.detected',
    label: 'Promo code detected',
    description:
      'Fires when the per-email coupon scanner finds at least one code. Single event with aggregate count; promo codes also land on the PromoCode collection for the promo-codes view.',
    emittedBy: ['IMAP sync', 'Gmail sync'],
    internalConsumers: [
      {
        name: 'Promo-code registry',
        description: 'Detected codes persist on the PromoCode collection.',
      },
    ],
    shipped: 'phase-2',
  },
  {
    kind: 'sender.blocked',
    label: 'Sender blocked',
    description:
      "Fires from POST /api/spam/block after the user blocks a sender and (optionally) the existing emails + pages from that sender are purged. Counts of what got deleted are on the event so a webhook recipe can report 'Rose just blocked X; 47 emails removed'.",
    emittedBy: ['API: POST /api/spam/block'],
    internalConsumers: [
      {
        name: 'IMAP / Gmail ingest gate',
        description:
          'Future arrivals from the blocked address are dropped at ingest, before any Email row is written.',
      },
    ],
    shipped: 'phase-2',
  },
  {
    kind: 'website.fetched',
    label: 'Website snapshot taken',
    description:
      "Fires when a 'watch a website' source successfully captures fresh content. The `via` field carries which path served the body — direct, rotated UA, RSS-feed fallback, or Wayback Machine — so recipes can react when an origin starts blocking or when archived content is being served instead of live.",
    emittedBy: ['Website-sync worker'],
    internalConsumers: [
      {
        name: 'Page generation',
        description: 'The snapshot becomes a kind=url Email row and feeds the normal page pipeline.',
      },
    ],
    shipped: 'phase-2',
  },
];

/** Quick existence check used by the matcher tests. */
export function getPipelineStage(kind: RecipeEventKind): PipelineStage | undefined {
  return PIPELINE_CATALOG.find((s) => s.kind === kind);
}
