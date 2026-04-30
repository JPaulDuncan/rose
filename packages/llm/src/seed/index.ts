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
    description: 'Generates a structured wiki page (title, summary, markdown body) from an email.',
    variables: ['email_subject', 'email_from', 'email_date', 'email_body', 'extra_instructions'],
    isDefault: true,
    template: `Convert the email below into a wiki entry.

REQUIREMENTS
- Title: a concise, descriptive noun phrase (no "Re:", no dates, < 80 chars).
- Summary: a single paragraph, ≤ 280 characters, neutral tone.
- Body: markdown. Use H2 sections like "Overview", "Key Points", "Decisions", "Action Items", "References" only when the source supports them. Use bullet lists for action items. Do not invent attendees, dates, or numbers.
- Tags: 3–7 short lowercase tags, hyphenated.

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}

EMAIL METADATA
- From: {{email_from}}
- Date: {{email_date}}
- Subject: {{email_subject}}

EMAIL BODY:
"""
{{email_body}}
"""

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
