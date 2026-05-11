import { z } from 'zod';
import { PredicateKey } from '../lib/ontology.js';

/**
 * Structured output of the relation-extraction LLM call. The
 * prompt lists the active predicate vocabulary; the LLM emits zero
 * or more `{subject, predicate, object}` triples with a confidence
 * + grounding snippet. The worker dedupes against the existing
 * EntityRelation rows (idempotent via the unique key).
 */
export const RelationExtraction = z.object({
  relations: z
    .array(
      z.object({
        /** Subject's surface form, as written in the body. */
        subject: z.string().trim().min(1).max(200),
        predicate: PredicateKey,
        /** Object's surface form. */
        object: z.string().trim().min(1).max(200),
        /** Model's 0..1 self-reported confidence. */
        confidence: z.number().min(0).max(1).default(0.6),
        /** A short body excerpt that justifies the claim, capped to
         *  240 chars so an over-eager model can't ship a paragraph. */
        snippet: z.string().trim().max(240).default(''),
      }),
    )
    .max(40)
    .default([]),
});
export type RelationExtraction = z.infer<typeof RelationExtraction>;

/**
 * Structured output of the subscription-extraction LLM call. Pages
 * that aren't subscription emails return `{ skip: true }` so the
 * worker can short-circuit without a parse failure.
 */
export const SubscriptionExtraction = z.discriminatedUnion('skip', [
  z.object({ skip: z.literal(true) }),
  z.object({
    skip: z.literal(false),
    /** Service / product name as it appears, e.g. "Netflix",
     *  "GitHub Pro", "AT&T fiber". */
    serviceName: z.string().trim().min(1).max(200),
    /** Recurring amount; null when not stated. */
    amount: z.number().nullable().default(null),
    /** ISO 4217 currency code, uppercase. */
    currency: z.string().trim().max(8).nullable().default(null),
    /** Renewal cadence. 'other' for irregular (e.g. usage-based). */
    cadence: z
      .enum(['monthly', 'yearly', 'quarterly', 'weekly', 'other'])
      .default('monthly'),
    /** Next renewal as an ISO date string, when known. */
    nextRenewalAt: z.string().trim().max(40).nullable().default(null),
    /** Lifecycle: 'active' (renews), 'cancelled' (user has cancelled
     *  but coverage may run out later), 'expired' (already ended). */
    status: z
      .enum(['active', 'cancelled', 'expired'])
      .default('active'),
    /** Optional category for the spending-dashboard rollups. */
    category: z
      .enum([
        'media',
        'software',
        'utility',
        'fitness',
        'news',
        'insurance',
        'cloud',
        'other',
      ])
      .nullable()
      .default(null),
  }),
]);
export type SubscriptionExtraction = z.infer<typeof SubscriptionExtraction>;
