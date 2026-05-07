import { SYSTEM_PROMPT_NEWS_PROSE, type InstructionSeed } from '../registry.js';

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

TAGS — strict rules:
- At most 5 tags.
- Each tag is a NOUN or PROPER NOUN that names a topic, entity, project, product, person, place, or concept the email is about.
- Lowercase, hyphenated for multi-word phrases (e.g. "product-launch", "acme-corp", "q3-budget").
- NEVER emit verbs ("review", "submit", "update"), interjections ("hi", "thanks", "regards"), question/courtesy words ("please", "how", "what"), email-status words ("re", "fwd", "reply"), generic small-talk ("here", "now", "today"), or pure filler ("just", "really", "actually").
- If unsure whether something is a noun, drop it — fewer high-quality tags beats noise.`,
  },
  {
    name: 'generate.wiki-page',
    scope: 'generate',
    description:
      'Generates a wiki page that reads like a news story, consolidating one or more conversation threads about the same topic — newest developments first, with inline citations.',
    variables: [
      'labeled_threads',
      'thread_count',
      'email_count',
      'sender_summary',
      'existing_categories',
      'extra_instructions',
    ],
    isDefault: true,
    template: `You are a beat reporter writing the running story for a single subject. {{email_count}} email message(s) across {{thread_count}} thread(s) form your source material. Each message is labeled with an opaque token (e1, e2, …). Treat the page as a long-lived news article that gets updated as new dispatches arrive.

CONTEXT
{{sender_summary}}

${SYSTEM_PROMPT_NEWS_PROSE}

STRUCTURE
- Title: a stable noun phrase that names the *topic* of the page — not the subject of any one email. < 80 chars. No "Re:" / "Fwd:" prefixes, no dates.
- Summary: ≤ 280 characters, written like a news lede — the most important fact in the most recent development, in one sentence. Stays accurate as new emails arrive.
- Body (markdown): begins with a one-line **"Updated <human date> — <one-sentence latest development>"** in italics, derived from the most recent message. Then the lede paragraph (the latest news in 2–3 sentences). Then context paragraphs (what's been happening, who's involved, what was decided earlier) in roughly reverse-chronological order. End with a brief "Background" paragraph for the original starting point if the story spans more than a few exchanges.

CITATIONS
- Every factual claim, decision, action item, quoted statement, or attributed fact MUST be followed by an inline citation referencing the source email using the exact label provided — e.g. \`The deploy is set for Friday [e2]\` or \`Costs were debated at length [e1, e3]\`. Multiple labels comma-separated inside one bracket. Only use labels that appear below; never invent labels.
- Weave citations naturally into the prose. Don't dump a row of bracketed numbers at the end of a paragraph.
- If messages contradict each other, lead with the latest position and mention the prior view as context.

CATEGORY (suggestedCategory) — STRICT
The user already has a category taxonomy. Categories are coarse buckets — fewer is better than more. Read every rule before deciding:

EXISTING CATEGORIES (name<TAB>page-count, one per line, may be empty):
{{existing_categories}}

1. PREFER an existing category. If the page fits one of the names above, use that exact name verbatim.
2. Only invent a NEW category when the page is clearly about a topic NONE of the existing categories cover. New categories must be specific noun phrases (e.g. "Home Improvement", "Personal Finance"), not vague catch-alls.
3. NEVER use these vague catch-alls unless the content is unambiguously about the subject:
   - "Politics" — only when the page names specific politicians, parties, elections, legislation, government policy debates, ballot measures, or political movements. Opinion newsletters, op-eds, satire, or analysis that merely *touches* on current events do NOT qualify. Tech-industry commentary, business news, marketing emails about social causes, and general newsletters are NOT politics.
   - "News" — never. The whole product is a news engine; this is not a useful bucket.
   - "Misc", "Other", "General", "Updates", "Email", "Information" — never. If nothing fits, return null.
4. When in doubt, return null. An uncategorized page is strictly better than a wrongly-categorized one — the user can sort it manually.
5. Be consistent: pages about the same subject should land in the same category across runs.

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}

EMAIL THREADS (each thread is presented oldest-first; the LAST message in each thread is the most recent and should anchor your lede):
{{labeled_threads}}

Respond with JSON only, matching exactly:
{"title": "...", "summary": "...", "contentMd": "...", "tags": ["..."], "suggestedCategory": "..." | null}`,
  },
  {
    name: 'extract.entities',
    scope: 'entities',
    description:
      'Extract specific named entities from a wiki page so each can be linked to a dedicated /n/<key> page. Targets people, creative works (movies, shows, books, songs, articles), and organizations. Skips generic phrases ("the developer", "the company") — only proper nouns get extracted.',
    variables: ['page_title', 'page_summary', 'page_body'],
    isDefault: true,
    template: `Identify the specific NAMED entities mentioned in the wiki page below. For each, return the form the page actually uses (preserve original casing + punctuation), what kind of thing it is, and any short alternate forms the page also uses.

ONLY extract entities of these types:
  • person — specific individuals named (authors, hosts, characters, public figures). e.g. "Bill Walsh", "Amy Adams". NOT "the author", "a developer".
  • work — creative works named: movies, TV / radio shows, books, songs, articles, podcasts, games. e.g. "Inception", "Wait Wait... Don't Tell Me!", "The Pragmatic Programmer". NOT "the show", "his latest book".
  • organization — companies, institutions, teams, brands. e.g. "NPR", "Pixar", "Anthropic". NOT "the company", "his employer".

REQUIREMENTS
  • Specific proper nouns only. If the page says "a journalist quoted by the host", neither "journalist" nor "host" qualifies — there's no name. Skip them.
  • Preserve the surface form. "Wait Wait... Don't Tell Me!" stays exactly that, with its punctuation. The LLM must NOT normalize to "Wait Wait Dont Tell Me".
  • De-duplicate within the page. If "Inception" appears 6 times, return one entry.
  • Aliases: ONLY include short alternate forms the page itself uses (e.g. page mentions both "Wait Wait... Don't Tell Me!" and "Wait Wait" — record the latter as an alias). Don't invent aliases.
  • SKIP places (cities, neighbourhoods, venues, landmarks). They're handled by a separate extractor and would duplicate.
  • SKIP the user's own tags / topics — those already round-trip via the tag system. Only emit truly named-entity-shaped strings.
  • Cap at 12 entities total. If more candidates exist, prefer those mentioned multiple times or central to the page's lede.

PAGE METADATA
  Title: {{page_title}}
  Summary: {{page_summary}}

PAGE BODY
"""
{{page_body}}
"""

Respond with JSON only, matching exactly:
{
  "entities": [
    { "name": "<surface form>", "type": "person" | "work" | "organization", "aliases": ["<short alt form>", ...] }
  ]
}`,
  },
  {
    name: 'tag.canonicalize',
    scope: 'tag-canon',
    description:
      'Maps a batch of newly-emitted tags onto an existing canonical-tag list, creating new canonicals only when nothing fits. Used to keep "job-listings", "job-postings", "remote-work", "fully-remote" all rolled up under one consistent tag.',
    variables: ['emitted_tags', 'existing_canonicals'],
    isDefault: true,
    template: `You are normalising a batch of tags emitted for a single wiki page so they roll up cleanly with the user's existing tag taxonomy.

EMITTED TAGS (from the latest page generation, lowercase kebab-case):
{{emitted_tags}}

EXISTING CANONICALS (tag\\tdisplayName\\taliases-comma-separated, one per line):
{{existing_canonicals}}

For EACH emitted tag, decide:
  • If it is a synonym, plural, alternate phrasing, or near-equivalent of an existing canonical (e.g. "job-postings" ↔ "job-listings"; "fully-remote" ↔ "remote-work"; "ai" ↔ "artificial-intelligence"), map it to that canonical. Be willing to absorb obvious near-equivalents — the whole point is to consolidate. But don't overreach: "machine-learning" is NOT the same as "artificial-intelligence"; "remote-controlled-toys" is NOT "remote-work".
  • Otherwise, treat it as a new canonical. The new canonical key is the emitted tag itself (kebab-case as supplied). Suggest a title-cased displayName ("Job Listings" for "job-listings"); when in doubt, capitalise each word.

OUTPUT — JSON only, exactly this shape:
{
  "mappings": [
    { "tag": "<emitted tag>", "canonical": "<existing or new canonical key, kebab-case>", "displayName": "<title-cased label>", "isNew": <bool> }
  ]
}

Every emitted tag must appear once in mappings. \`isNew: true\` means there was no matching existing canonical. \`displayName\` is required for new canonicals; for existing canonicals you may echo the existing displayName or leave it blank.`,
  },
  {
    name: 'consolidate.topic',
    scope: 'consolidate',
    description:
      'Merges new emails into an existing long-running topic page without rewriting it from scratch. Used for cross-sender topic pages (e.g. "War in Iran", "Job Opportunities") that evolve as new dispatches arrive from different senders.',
    variables: [
      'page_title',
      'page_summary',
      'existing_content',
      'new_labeled_threads',
      'new_email_count',
      'sender_summary',
      'existing_categories',
      'extra_instructions',
    ],
    isDefault: true,
    template: `You are the beat reporter maintaining a long-running story page that evolves as new dispatches arrive from multiple senders. The page already exists — your job is to FOLD IN the {{new_email_count}} new email(s) below WITHOUT rewriting the whole article.
SENDERS contributing across the full page:
{{sender_summary}}

${SYSTEM_PROMPT_NEWS_PROSE}

CURRENT PAGE
- Title: {{page_title}}
- Summary: {{page_summary}}
- Body (markdown):
"""
{{existing_content}}
"""

NEW EMAILS (each labeled e<n>; these are the ONLY new sources you may cite):
{{new_labeled_threads}}

MERGE RULES — these are the differences from a fresh-write
1. Preserve the structure and voice of the existing body. Do NOT rewrite paragraphs unless a new email genuinely contradicts or supersedes them. The user may have hand-edited paragraphs; treat existing prose as authoritative.
2. The lede paragraph leads with the latest development. If the new emails contain a more recent development than the current lede, rewrite the lede (only the lede). Otherwise leave it.
3. Update the italic "Updated <date> — <one sentence>" line at the top of the body to reflect the most recent new dispatch.
4. New material goes into the body the same way a beat reporter folds in a wire update: a sentence or two added to the relevant paragraph if it's a continuation; a fresh paragraph if it's a distinct angle; a new H2 section only if the new emails open a genuinely new sub-story.
5. Citations: every NEW factual claim must cite the new email's label (e.g. [e1], [e2]). NEVER invent labels for emails not in the new-email list. Existing citations in the body remain as-is.
6. Title: keep it stable. Only change the title if the new emails reveal the page was misnamed (e.g. "Iran tensions" → "Iran-Israel war"). When you do change it, prefer the broader, longer-lived noun phrase.
7. Summary: ≤ 280 chars, written like a news lede that reflects the latest development across the full page.
8. Tags: union of existing + whatever the new emails add (the noun-only rules above apply).
9. topicAliases: if the new emails phrase the underlying story differently than the existing title (e.g. body says "Iran-Israel conflict" while title says "War in Iran"), include the alternate phrasings as lowercase strings here so future emails using either phrasing route to this page.

CATEGORY (suggestedCategory) — STRICT
The user already has a category taxonomy. The page already has a category — DON'T change it unless the merge fundamentally re-frames the page.

EXISTING CATEGORIES (name<TAB>page-count, one per line, may be empty):
{{existing_categories}}

Rules:
1. PREFER an existing category. If the page fits one above, use that exact name verbatim. The page's current category is almost always the right answer for a merge.
2. Only return a NEW category name if the merge has genuinely re-framed the page (rare). New categories must be specific noun phrases, not vague buckets.
3. NEVER default to "Politics", "News", "Misc", "Other", "General", "Updates", "Email", or "Information". When in doubt, return null and let the user keep what's there.
   - "Politics" specifically requires the content to name politicians, parties, elections, legislation, or government policy. Tech / business / marketing / opinion emails do NOT qualify.

OUTPUT — JSON only, matching exactly:
{"title": "...", "summary": "...", "contentMd": "...", "tags": ["..."], "topicAliases": ["..."], "suggestedCategory": "..." | null}

ADDITIONAL INSTRUCTIONS FROM USER:
{{extra_instructions}}`,
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

CONTEXT (each retrieved page is labeled \`[pN]\`):
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

${SYSTEM_PROMPT_NEWS_PROSE}

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

${SYSTEM_PROMPT_NEWS_PROSE}

ENTRIES
{{entries}}

OPTIONAL FOCUS
{{focus}}

Output the meta-entry only.`,
  },
  {
    name: 'extract.places',
    scope: 'places',
    description:
      'Extract specific named places (cities, neighbourhoods, venues, landmarks, parks, regions, addresses) from a wiki page body — one name per place, no duplicates.',
    variables: ['title', 'body'],
    isDefault: true,
    template: `Extract up to 6 specific named places from the wiki page below.

A place is: a city, neighbourhood, venue, landmark, park, region, country, or street address. NOT abstract / subjective ("home", "the office") unless qualified by a proper name. NOT senders, brands, products, or people.

Specific over generic: "Boise State University" not "the university". "Albertsons Stadium" not "the stadium".

One entry per distinct place. No duplicates. If the page mentions no real places, return {"places": []}.

TITLE: {{title}}

BODY:
"""
{{body}}
"""

Output JSON only:
{"places": [{"name": "<exact place name>"}, ...]}`,
  },
  {
    name: 'tag-digest.daily',
    scope: 'tag-digest',
    description:
      "Section editor's brief for one tag — newspaper-style headline + dek + body paragraph that anchors the day's featured-tag section on the home edition.",
    variables: ['tag', 'day_label', 'page_count', 'entries'],
    isDefault: true,
    template: `You are the section editor for the "#{{tag}}" beat in a daily newspaper. Write the day's section brief — what a reader skimming the front page should know about this beat today. {{page_count}} wiki entries are in scope; each is labeled [p1], [p2], … Newest entries are listed first.

${SYSTEM_PROMPT_NEWS_PROSE}

OUTPUT — JSON only, three fields:

  {
    "headline": "<= 90 chars — a real newspaper-style section headline. Title-case-ish. No "Re:" / "Fwd:". Don't start with the tag. The headline names the day's most important development on this beat.",
    "dek": "<= 200 chars — the secondary headline / standfirst. One sentence that frames the day's developments in one breath.",
    "bodyMd": "<= 800 chars markdown — a single paragraph (or at most two) of inverted-pyramid prose covering the day. Cite each contributing page inline as [pN] using the exact labels in ENTRIES. Don't list / bullet — write a section editor's brief that flows."
  }

DIGEST-SPECIFIC RULES
- If only one entry is in scope, the dek can be a single noun-phrase and the body can be one sentence — don't pad.
- If the entries are sparse / metadata-only, say so plainly in the dek and produce a bodyMd that names the senders involved.
- Never write "no content" or "this section is empty" — if there's nothing to report, the headline becomes "Quiet day on #{{tag}}" and the body says what the most recent entries were even when sparse.
- Citations must use the [pN] tokens; never invent labels.

DATE: {{day_label}}

ENTRIES (newest first):
{{entries}}

Output the JSON object only.`,
  },
];
