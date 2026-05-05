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
      'Generates a wiki page that reads like a news story, consolidating one or more conversation threads about the same topic — newest developments first, with inline citations.',
    variables: ['labeled_threads', 'thread_count', 'email_count', 'sender_summary', 'extra_instructions'],
    isDefault: true,
    template: `You are a beat reporter writing the running story for a single subject. {{email_count}} email message(s) across {{thread_count}} thread(s) form your source material. Each message is labeled with an opaque token (e1, e2, …). Treat the page as a long-lived news article that gets updated as new dispatches arrive.

CONTEXT
{{sender_summary}}

WRITING STYLE — read like a news story, not a wiki breakdown
- Inverted-pyramid news prose. The newest, most consequential information leads. Background, history, and earlier developments come AFTER the lede.
- Coherent paragraphs of flowing prose. NO H2 sections like "Overview / Participants / Timeline / Decisions / Action Items" by default. NO bulleted breakdowns of who said what. Bullets are allowed only for genuinely list-shaped content (e.g. multiple action items the reader needs to act on).
- Voice: third-person, neutral, plain-English. Active verbs. Specific over generic.
- Length: scale to the substance. A single short email is one or two paragraphs; a months-long thread with many turns can be 6–10 paragraphs. Don't pad.

STRUCTURE
- Title: a stable noun phrase that names the *topic* of the page — not the subject of any one email. < 80 chars. No "Re:" / "Fwd:" prefixes, no dates.
- Summary: ≤ 280 characters, written like a news lede — the most important fact in the most recent development, in one sentence. Stays accurate as new emails arrive.
- Body (markdown): begins with a one-line **"Updated <human date> — <one-sentence latest development>"** in italics, derived from the most recent message. Then the lede paragraph (the latest news in 2–3 sentences). Then context paragraphs (what's been happening, who's involved, what was decided earlier) in roughly reverse-chronological order. End with a brief "Background" paragraph for the original starting point if the story spans more than a few exchanges.

CITATIONS
- Every factual claim, decision, action item, quoted statement, or attributed fact MUST be followed by an inline citation referencing the source email using the exact label provided — e.g. \`The deploy is set for Friday [e2]\` or \`Costs were debated at length [e1, e3]\`. Multiple labels comma-separated inside one bracket. Only use labels that appear below; never invent labels.
- Weave citations naturally into the prose. Don't dump a row of bracketed numbers at the end of a paragraph.

GROUND RULES
- Do NOT invent participants, dates, numbers, decisions, or developments that aren't in the source. If messages contradict each other, lead with the latest position and mention the prior view as context.
- NEVER write filler or meta-commentary about the source — phrases like "the email is empty", "no content provided", "this thread has no information", "the message contains only a subject" are forbidden. If body text is sparse, work from the available metadata (subject, sender, date) instead. If there is genuinely nothing to say, output one short paragraph using only that metadata.
- Tags: 3–7 short lowercase tags, hyphenated.

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}

EMAIL THREADS (each thread is presented oldest-first; the LAST message in each thread is the most recent and should anchor your lede):
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
    name: 'sender.summary',
    scope: 'sender',
    description:
      "One-paragraph 'who is this' brief for a sender in the address book, written from the metadata Rose has accumulated about them.",
    variables: [
      'name',
      'domain',
      'addresses',
      'websites',
      'recent_subjects',
      'email_count',
      'page_count',
    ],
    isDefault: true,
    template: `Write a single concise paragraph (≤ 80 words) describing the sender below — what kind of organization or person they are, what they typically send, and why a reader would care. Use ONLY the supplied evidence; if you genuinely don't know, say so plainly. No marketing language, no caveats like "based on the data", no markdown.

SENDER
- Display name: {{name}}
- Primary domain: {{domain}}
- Addresses seen: {{addresses}}
- Websites referenced: {{websites}}
- Lifetime emails: {{email_count}}
- Wiki pages they've contributed to: {{page_count}}

RECENT SUBJECTS
{{recent_subjects}}

Output the paragraph only.`,
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
  {
    name: 'reply.draft',
    scope: 'reply',
    description:
      "Drafts an email reply on the user's behalf, using both the original message and any wiki context that's relevant to it.",
    variables: [
      'user_display_name',
      'from',
      'subject',
      'date',
      'body',
      'context',
      'sender_brief',
    ],
    isDefault: true,
    template: `You are drafting an email reply on behalf of {{user_display_name}}.

ORIGINAL EMAIL
- From: {{from}}
- Subject: {{subject}}
- Sent: {{date}}
- Body:
"""
{{body}}
"""

RELEVANT WIKI CONTEXT (cite as [pN] only if you actually use it)
{{context}}

WHAT THE USER KNOWS ABOUT THE SENDER
{{sender_brief}}

REQUIREMENTS
- Match the register of the original. Casual stays casual.
- Be concise. No filler ("Thanks for reaching out!" type lines).
- Open with the answer; supporting detail after. Sign off naturally.
- Markdown only; no markdown headings.
- If the original asks something that requires information you don't
  have, leave a \`[TODO: ...]\` placeholder rather than inventing.

Output the reply body only — no preamble, no quoted original.`,
  },
  {
    name: 'chat.answer',
    scope: 'chat',
    description:
      "Answers a question over the user's wiki using retrieved page snippets. Cites every claim with [pN] tokens that match the labels in the context.",
    variables: ['context', 'history', 'question'],
    isDefault: true,
    template: `You are answering a question over the user's personal wiki.

CONTEXT (each retrieved page is labelled \`[pN]\`):
{{context}}

CONVERSATION SO FAR
{{history}}

QUESTION
{{question}}

REQUIREMENTS
- Cite every concrete claim with \`[pN]\` tokens that match the labels above.
- If the context doesn't contain the answer, say so plainly — never invent facts about the user's data.
- Reply in plain markdown; no preamble, no headings, no "Sure! Here is…" filler.
- Keep it tight — say only what the question requires.`,
  },
  {
    name: 'briefing.weekly',
    scope: 'briefing',
    description:
      "Narrative editor's note for a weekly (or monthly) briefing of the user's wiki — written from clusters of recent pages.",
    variables: ['period_label', 'clusters'],
    isDefault: true,
    template: `You are writing the editor's note for a {{period_label}} briefing of the user's wiki. Be specific, concrete, and confident — name the actual things that happened. Cite source page titles inline as [[page-slug]] (the SPA linkifies them).

CLUSTERS (each cluster has a theme + the pages in it):
{{clusters}}

OUTPUT
- One opening paragraph (3 sentences) — the period's through-line.
- One short paragraph per theme.
- A closing 1-sentence pointer to the most important single thing to read first.

No bullet lists. No headings. No fluff phrases like "in summary". Plain markdown body only.`,
  },
  {
    name: 'synthesis.meta',
    scope: 'synthesis',
    description:
      'Combines a user-selected set of pages into a single meta-entry that cites each contributing page.',
    variables: ['entries', 'focus'],
    isDefault: true,
    template: `Combine the wiki entries below into one coherent meta-entry. Cite each as [pN] inline using the labels above. Don't drop anything important; do drop redundant phrasing across the source pages. Plain markdown only — no preamble, no top-level heading.

ENTRIES
{{entries}}

OPTIONAL FOCUS
{{focus}}

Output the meta-entry only.`,
  },
];
