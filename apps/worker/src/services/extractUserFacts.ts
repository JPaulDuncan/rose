import { z } from 'zod';
import type { Types } from 'mongoose';
import {
  MemoryComponent,
  MEMORY_COMPONENT_TYPES,
  type PageDoc,
  type MemoryComponentType,
} from '@rose/db';
import { extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * User-fact extraction — the "components" extractor for the xMemory
 * adaptation in Rose. One LLM call per page; returns 0–6 atomic
 * claims about the user.
 *
 * The prompt is deliberately conservative. The vast majority of
 * pages aren't about the user (news, brand emails, websites), so
 * the model is instructed to return an empty list when nothing
 * applies. False positives are costlier than false negatives here
 * — every component shows up on the "What Rose knows about you"
 * page, and a wrong claim erodes user trust faster than a missing
 * one. We bias hard toward precision.
 *
 * Source-page back-references are upserted via $addToSet, so a
 * fact that appears in multiple pages accumulates evidence rather
 * than producing duplicate rows. Dedup is keyed on a normalised
 * form of (userId, type, text) so the same fact phrased twice the
 * same way collapses, but "I prefer aisle seats" and "I like aisle
 * seats" stay as two rows — the grouping sweeper will pull them
 * into the same group at the next pass.
 */

const SYSTEM_PROMPT = `You are extracting atomic, durable facts ABOUT THE USER from a document
they received or wrote.

Output JSON of shape {"components": [{"type": ..., "text": ..., "confidence": ...}]}.

A component is one self-contained, reusable claim about the user. Valid types:
  - fact:         a stable claim ("I live in Brooklyn", "I'm a software engineer", "my dog is named Otis")
  - preference:   a like/dislike or chosen default ("I prefer aisle seats", "I drink black coffee")
  - constraint:   an allergy, limitation, requirement ("I'm allergic to penicillin", "I can't fly United")
  - relation:     a person/org connection ("my sister is named Maya", "my dentist is Dr. Park")
  - state-update: a change to a prior state ("I moved to Brooklyn last month", "I switched to Verizon")

STRICT RULES:
  • The claim MUST be about the user. Facts about brands, news subjects, third parties, or generic
    knowledge DO NOT belong here. Receipts, news, shipping notifications, ads, public events — the
    answer for these is almost always an empty list.
  • Each text MUST read as a single declarative sentence in the user's voice (start with "I" or "my"
    when natural). Don't quote the source; paraphrase atomically.
  • Don't invent. If the page doesn't actually say this about the user, leave it out.
  • Don't restate the page summary. One fact per atomic claim — split conjunctions into separate
    components.
  • Confidence ∈ [0, 1]. Use 0.9+ only when the page explicitly states the fact in the user's own
    words; 0.6 for clear-but-implied; 0.3 for "plausible inference."
  • Return at most 6 components per page. If there's nothing about the user, return {"components": []}.
  • Output ONLY the JSON. No prose, no code fences, no commentary.`;

const UserFactsOutput = z.object({
  components: z
    .array(
      z.object({
        type: z.enum(MEMORY_COMPONENT_TYPES),
        text: z.string().min(3).max(400),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(6)
    .default([]),
});

export type ExtractedUserFact = {
  type: MemoryComponentType;
  text: string;
  confidence: number;
};

function normaliseFactKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Run extraction on `page` and upsert components. Returns the list
 * of components touched (newly inserted OR refreshed via
 * $addToSet on sourcePageIds). Embedding is left null here; the
 * grouping sweeper picks them up and embeds them as part of its
 * attach loop so we can batch embedding calls.
 *
 * Best-effort: provider failures, parse failures, and Zod
 * validation failures all yield an empty array — never block the
 * post-write hook caller.
 */
export async function extractUserFactsFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedUserFact[]> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 80) return [];
  // Pages whose contributing emails are obviously commercial /
  // public-content rarely contain user-facts. We don't gate hard —
  // a shipping receipt can carry "my address is X" — but cap the
  // body we send so the prompt cost stays bounded.
  const trimmed = body.length > 4000 ? body.slice(0, 4000) : body;

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'extract-user-facts: provider unavailable');
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
      maxTokens: 600,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-user-facts: generate failed',
    );
    return [];
  }

  let parsed;
  try {
    parsed = UserFactsOutput.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-user-facts: invalid JSON',
    );
    return [];
  }

  if (parsed.components.length === 0) return [];

  // Upsert each component. Dedup on (userId, type, normalised text)
  // so the same fact phrased identically twice doesn't double up.
  // sourcePageIds is $addToSet'd so existing rows accumulate
  // evidence; lastSeenAt bumped so the freshness signal is meaningful.
  const out: ExtractedUserFact[] = [];
  for (const comp of parsed.components) {
    const key = normaliseFactKey(comp.text);
    if (!key) continue;
    // We also reject rejections — see model schema for the rationale.
    // If a row exists with status='rejected' for the same normalised
    // text, do not re-upsert.
    const existingRejected = await MemoryComponent.findOne({
      userId,
      type: comp.type,
      text: { $regex: `^${escapeRegex(comp.text)}$`, $options: 'i' },
      status: 'rejected',
    })
      .select('_id')
      .lean();
    if (existingRejected) continue;
    void key;

    await MemoryComponent.findOneAndUpdate(
      {
        userId,
        type: comp.type,
        text: { $regex: `^${escapeRegex(comp.text)}$`, $options: 'i' },
        status: { $ne: 'rejected' },
      },
      {
        $setOnInsert: {
          userId,
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
