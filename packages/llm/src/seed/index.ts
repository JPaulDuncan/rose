import type { InstructionSeed } from '../registry.js';

export const SEED_INSTRUCTIONS: InstructionSeed[] = [
  {
    name: 'parse.cleanup',
    scope: 'parse',
    description: 'Strips signatures, quoted replies, disclaimers from a raw email body.',
    variables: ['email_body'],
    isDefault: true,
    template: `Remove signatures, legal disclaimers, "Sent from my…" footers, and quoted reply chains from the email body below. Keep the original meaning and any inline content. Return only the cleaned body, no commentary.

EMAIL BODY:
"""
{{email_body}}
"""`,
  },
  {
    name: 'categorize.default',
    scope: 'categorize',
    description: 'Picks a category and up to 5 tags from the user’s category tree.',
    variables: ['email_subject', 'email_body', 'existing_categories'],
    isDefault: true,
    template: `You will categorize an email into the user's existing wiki taxonomy.

EXISTING CATEGORIES (one per line, may be empty):
{{existing_categories}}

EMAIL SUBJECT: {{email_subject}}
EMAIL BODY:
"""
{{email_body}}
"""

Respond with JSON only, matching this shape:
{"category": "<existing or new category name>", "isNewCategory": <bool>, "tags": ["tag1", "tag2"]}
At most 5 tags. Tags are short, lowercase, hyphenated.`,
  },
  {
    name: 'generate.wiki-page',
    scope: 'generate',
    description:
      'Generates a structured wiki page from a single email or a full thread, with inline citations.',
    variables: ['labeled_emails', 'email_count', 'extra_instructions'],
    isDefault: true,
    template: `You are turning an email thread into a single wiki entry. The thread contains {{email_count}} message(s), each labeled with an opaque token (e1, e2, …). Treat the messages as a chronological conversation.

REQUIREMENTS
- Title: a concise, descriptive noun phrase capturing the topic of the conversation (no "Re:", no dates, < 80 chars).
- Summary: a single paragraph, ≤ 280 characters, neutral tone — a tl;dr of the whole thread.
- Body: markdown. Use H2 sections that suit the source, drawn from this set when supported by the content: "Overview", "Participants", "Timeline", "Decisions", "Action Items", "Open Questions", "Key Points", "References". For threads, prefer "Timeline" so the chronology is clear; for single messages, "Overview" + "Key Points" is usually enough. Use bullet lists for action items.
- Citations: every factual claim, decision, action item, quote, or attributed statement MUST be followed by an inline citation referencing the email it came from, using the exact label provided — e.g. \`The deploy is on Friday [e2]\` or \`Costs were debated [e1, e3]\`. Use only labels listed below; never invent labels. Place citations at end of sentence or list-item; multiple labels comma-separated inside a single bracket.
- Do NOT invent participants, dates, numbers, or decisions that aren't in the source. If the source is contradictory across messages, note the disagreement and cite both.
- Tags: 3–7 short lowercase tags, hyphenated.

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}

EMAIL THREAD (oldest first):
{{labeled_emails}}

Respond with JSON only, matching exactly:
{"title": "...", "summary": "...", "contentMd": "...", "tags": ["..."], "suggestedCategory": "..." | null}`,
  },
  {
    name: 'link.suggest',
    scope: 'link',
    description: 'Given a candidate page and similar pages, suggests which to link.',
    variables: ['candidate_summary', 'neighbor_list'],
    isDefault: true,
    template: `You are suggesting which existing wiki pages a new page should link to.

NEW PAGE SUMMARY:
{{candidate_summary}}

NEAREST NEIGHBORS (id\\ttitle\\tsummary, one per line):
{{neighbor_list}}

Return JSON only:
{"links": [{"pageId": "...", "reason": "<one sentence>"}]}
Include only neighbors that are clearly related. It is fine to return an empty list.`,
  },
  {
    name: 'dedupe.detect',
    scope: 'dedupe',
    description: 'Decides whether a candidate page is a duplicate of an existing page.',
    variables: ['candidate', 'neighbor'],
    isDefault: true,
    template: `Decide whether the CANDIDATE page is essentially a duplicate of the NEIGHBOR page.

CANDIDATE:
{{candidate}}

NEIGHBOR:
{{neighbor}}

Return JSON only:
{"isDuplicate": <bool>, "confidence": <0..1>, "reason": "<one sentence>"}`,
  },
];
