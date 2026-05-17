import { z } from 'zod';
import type { Types } from 'mongoose';
import {
  MemoryComponent,
  MEMORY_COMPONENT_TYPES,
  MEMORY_COMPONENT_SUBJECTS,
  type PageDoc,
  type MemoryComponentType,
  type MemoryComponentSubject,
} from '@rose/db';
import { extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Memory-component extraction — the "components" layer of the
 * xMemory adaptation (arXiv:2602.02007). One LLM call per page,
 * dual-output:
 *
 *   - `subject: 'user'`   — atomic claims ABOUT THE USER. Drives
 *                           prompt augmentation in narrative
 *                           generators (briefing, tag-digest)
 *                           and disambiguation in daydream.
 *   - `subject: 'world'`  — atomic claims about subjects IN the
 *                           page (people, places, works, orgs,
 *                           events). Future retrieval-augmented
 *                           consumers (chat-RAG, daydream snippet
 *                           expansion) use these to ground prose
 *                           in claims already-extracted.
 *
 * Both share the same MemoryComponent table + same grouping
 * sweeper. Groups stay homogeneous (a group is all-user or
 * all-world; the sweeper's attach step enforces this) so each
 * consumer can filter by `subject` without scanning everything.
 *
 * Source-page back-references are upserted via $addToSet so a
 * fact that appears in multiple pages accumulates evidence
 * rather than producing duplicate rows. Re-extraction on
 * unchanged content is short-circuited by the caller via a
 * content-hash gate on the Page.
 */

const SYSTEM_PROMPT = `You are extracting atomic, durable claims from a document Rose just generated for its user.
There are two kinds of claims. Each component you emit is one or the other:

  - subject="user":   a claim ABOUT THE USER (the recipient of this document).
                      Types: fact | preference | constraint | relation | state-update
                      Examples:
                        - "I live in Brooklyn"
                        - "I prefer aisle seats"
                        - "I'm allergic to penicillin"
                        - "my dog is named Otis"
                        - "I moved to Brooklyn last month" (state-update)
                      Voice: first person ("I ..." or "my ...").

  - subject="world":  a claim about a subject NAMED in the page (a person, place,
                      work, organization, event). Stable, verifiable, and the kind
                      of fact you'd find on a Wikipedia infobox.
                      Types: fact | relation | state-update
                      Examples:
                        - "The Drama is a 2017 film distributed by A24"
                        - "A24 was founded in 2012 by Daniel Katz"
                        - "Tropic Hotel is located at 230 Sunset Drive"
                        - "Stripe acquired Bouncer in 2021" (state-update)
                      Voice: third person, the subject first.

Output JSON:
  {"components": [{"subject": "user"|"world", "type": ..., "text": ..., "confidence": ...}]}

STRICT RULES:
  • At most 6 user components AND at most 6 world components. Total ≤ 12.
  • Atomic — split conjunctions ("Stripe acquired Bouncer in 2021 and TaxJar in 2021"
    is TWO components).
  • For world components: skip generic marketing claims ("the best deal ever"),
    ephemeral details ("ships in 3 days"), and internal corporate puffery that
    doesn't survive the document's context.
  • Don't invent. Every claim must be directly supported by the page text. If a
    claim is implied rather than stated, lower the confidence accordingly.
  • Confidence ∈ [0, 1]. Use 0.9+ only when the page states the claim explicitly;
    0.6 for clear-but-implied; 0.3 for "plausible inference."
  • If the page is purely transactional / marketing fluff with no atomic claims
    of either kind, return {"components": []}.
  • Output ONLY the JSON. No prose, no code fences, no commentary.`;

const ComponentsOutput = z.object({
  components: z
    .array(
      z.object({
        subject: z.enum(MEMORY_COMPONENT_SUBJECTS),
        type: z.enum(MEMORY_COMPONENT_TYPES),
        text: z.string().min(3).max(400),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(12)
    .default([]),
});

export type ExtractedComponent = {
  subject: MemoryComponentSubject;
  type: MemoryComponentType;
  text: string;
  confidence: number;
};

/** Back-compat alias — the old name is still imported by tests. */
export type ExtractedUserFact = ExtractedComponent;

/**
 * Run extraction on `page` and upsert components. Returns the list
 * of components touched. Embedding stays null here — the grouping
 * sweeper batches embed calls per user, which is cheaper than
 * per-component round-trips during the post-write hot path.
 *
 * Best-effort: provider failures, parse failures, and Zod
 * validation failures all yield an empty array — never block the
 * caller (page generation / synthesis routes).
 */
export async function extractComponentsFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedComponent[]> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 80) return [];
  const trimmed = body.length > 4000 ? body.slice(0, 4000) : body;

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'extract-components: provider unavailable');
    return [];
  }

  const prompt = [
    `PAGE TITLE: ${page.title ?? ''}`,
    page.summary ? `PAGE SUMMARY: ${page.summary}` : '',
    '',
    'PAGE BODY:',
    trimmed,
  ]
    .filter(Boolean)
    .join('\n');

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system: SYSTEM_PROMPT,
      format: 'json',
      temperature: 0.1,
      maxTokens: 900,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-components: generate failed',
    );
    return [];
  }

  let parsed;
  try {
    parsed = ComponentsOutput.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-components: invalid JSON',
    );
    return [];
  }

  if (parsed.components.length === 0) return [];

  // Dedup on (userId, subject, type, normalised text). Re-extracting
  // the same fact from another page adds the new pageId to
  // sourcePageIds without creating a second row.
  const out: ExtractedComponent[] = [];
  for (const comp of parsed.components) {
    // Suppress re-emission of anything the user has explicitly
    // rejected. The deny-list match is case-insensitive but does
    // NOT collapse semantically-equivalent paraphrases — that's
    // the grouping sweeper's job.
    const existingRejected = await MemoryComponent.findOne({
      userId,
      subject: comp.subject,
      type: comp.type,
      text: { $regex: `^${escapeRegex(comp.text)}$`, $options: 'i' },
      status: 'rejected',
    })
      .select('_id')
      .lean();
    if (existingRejected) continue;

    await MemoryComponent.findOneAndUpdate(
      {
        userId,
        subject: comp.subject,
        type: comp.type,
        text: { $regex: `^${escapeRegex(comp.text)}$`, $options: 'i' },
        status: { $ne: 'rejected' },
      },
      {
        $setOnInsert: {
          userId,
          subject: comp.subject,
          type: comp.type,
          text: comp.text,
          confidence: comp.confidence,
          status: 'active',
          firstSeenAt: new Date(),
        },
        $set: { lastSeenAt: new Date() },
        $addToSet: { sourcePageIds: page._id },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    out.push(comp);
  }
  return out;
}

/**
 * Back-compat shim. The first-cut extractor only handled user-facts;
 * call sites that still expect that narrower output keep working,
 * but the function now filters from the dual-output extraction.
 * New callers should use `extractComponentsFromPage` directly.
 */
export async function extractUserFactsFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedComponent[]> {
  const all = await extractComponentsFromPage(userId, page);
  return all.filter((c) => c.subject === 'user');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
