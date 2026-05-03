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
      'Generates a wiki page that consolidates one or more conversation threads from related emails, with inline citations.',
    variables: ['labeled_threads', 'thread_count', 'email_count', 'sender_summary', 'extra_instructions'],
    isDefault: true,
    template: `You are producing a single wiki entry that consolidates {{email_count}} email message(s) across {{thread_count}} conversation thread(s) on the same topic. Each message is labeled with an opaque token (e1, e2, …). Treat threads as separate sub-conversations; treat the page as a long-lived knowledge entry.

CONTEXT
{{sender_summary}}

REQUIREMENTS
- Title: a stable noun phrase that names the *topic* of the page — not the subject of any one email. < 80 chars. No "Re:" / "Fwd:" prefixes, no dates.
- Summary: ≤ 280 characters, neutral tone, written so it stays accurate as new emails arrive.
- Body: markdown. Pick H2 sections that fit the source, drawn from this set: "Overview", "Participants", "Timeline", "Decisions", "Action Items", "Open Questions", "Key Points", "References". When more than one thread is present, include a "Threads" section with one short paragraph per thread (subject, date range, what was decided), each citing the messages in that thread. Use bullet lists for action items.
- Citations: every factual claim, decision, action item, quote, or attributed statement MUST be followed by an inline citation referencing the source email using the exact label provided — e.g. \`The deploy is on Friday [e2]\` or \`Costs were debated [e1, e3]\`. Multiple labels comma-separated inside one bracket. Only use labels that appear below; never invent labels.
- Do NOT invent participants, dates, numbers, or decisions that aren't in the source. If messages contradict each other, note the disagreement and cite both.
- NEVER write filler or meta-commentary about the source — phrases like "the email is empty", "no content provided", "this thread has no information", "the message contains only a subject" are forbidden. If body text is sparse, work from the available metadata (subject, sender, date) instead. If there is genuinely nothing to say, output an "Overview" with one sentence using only that metadata.
- Tags: 3–7 short lowercase tags, hyphenated.

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}

EMAIL THREADS (each thread oldest-first):
{{labeled_threads}}

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
  {
    name: 'extract.events',
    scope: 'events',
    description:
      'Extract concrete future events (concerts, meetings, deadlines, deliveries, appointments) mentioned in an email.',
    variables: ['email_subject', 'email_from', 'email_date', 'email_body'],
    isDefault: true,
    template: `Identify any concrete future events that are explicitly mentioned in the email below. Examples: a concert on a specific date, a meeting with a specific time, a delivery window, an appointment, a deadline.

REQUIREMENTS
- Only events that have a clear date (and a time, if specified) — do NOT make up dates.
- Resolve relative dates ("next Friday at 6pm", "in 2 weeks") using the email's send date as the anchor.
- Use ISO-8601 with timezone offset when the email implies a timezone; otherwise emit the local time without offset (e.g. "2026-08-12T18:00:00").
- If a time is not given, set "allDay": true and omit the time component (e.g. "2026-08-12").
- Title: ≤ 80 chars, the thing happening (not the email subject).
- Skip generic dates already in the past relative to the email's send date.
- If the email contains no concrete events, return {"events": []}.

EMAIL METADATA
- Subject: {{email_subject}}
- From:    {{email_from}}
- Sent:    {{email_date}}

EMAIL BODY
"""
{{email_body}}
"""

Respond with JSON only, matching exactly:
{"events": [
  {"title": "...", "start": "<ISO-8601>", "end": null | "<ISO-8601>", "allDay": <bool>, "location": null | "...", "description": "<one sentence>"}
]}`,
  },
  {
    name: 'weather.brief',
    scope: 'weather',
    description:
      "Concise weather brief shown at the top of the user's daily newsletter, written from NOAA forecast data.",
    variables: ['location', 'now', 'forecast_data'],
    isDefault: true,
    template: `You are writing a brief weather update for "{{location}}" to sit at the top of a daily newsletter. Use ONLY the NOAA forecast JSON below — never invent specifics.

Output 2-3 short sentences (≤ 80 words total). Mention current conditions, today's high/low if knowable from the periods, and any meaningful change in the next 24 hours (rain moving in, temp drop, wind picking up). Friendly, plain-spoken tone — no caveats like "according to the forecast", no preamble, no markdown headers.

Current time: {{now}}

NOAA periods:
{{forecast_data}}

Output the brief only.`,
  },
];
