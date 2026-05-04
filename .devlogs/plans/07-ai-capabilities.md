# 07 — AI capabilities

Opportunistic features that reuse the existing LLM provider plumbing
to add capability rather than infrastructure: weekly briefings, vision
over inline images, cross-page synthesis, and voice notes.

## Goal

These four features all sit cleanly on top of existing infra
(`@rose/llm` providers, embeddings, instruction registry). None
require new persistent collections beyond the conversation/messages
tables introduced in plan 01.

## Components

1. [Weekly briefing](#weekly-briefing)
2. [Vision over inline images](#vision-over-inline-images)
3. [Cross-page synthesis](#cross-page-synthesis)
4. [Voice notes](#voice-notes)

---

## Weekly briefing

A narrative LLM-generated digest, not a list. Once a week, summarise
"what mattered" across all the wiki's new pages.

### Trigger

A repeatable BullMQ job per user, scheduled at the user's configured
time (reuses the digest-email scheduling shape from plan 04).

### Pipeline

1. Pull all pages updated in the past 7 days (excluding spam,
   quarantined, and promotional unless the user opted in).
2. Cluster them by their topic centroids (k-means or simple greedy)
   into ≤ 5 themes. Each theme gets a label from the most common
   primary topic / tag.
3. For each cluster, send the LLM a structured prompt with the
   cluster's pages (title + summary + top-3 citations) and ask for a
   2-paragraph narrative.
4. Top-level prompt asks for a 3-sentence "lede" pulling together the
   week.
5. Persist the result as a `Page` with `groupingMode='briefing'` (new
   enum variant) so it shows up in search and can be opened directly.

### Prompt

New system instruction `briefing.weekly` (scope: new — `briefing`):

```
You are writing the editor's note for a weekly briefing of the user's
wiki. Be specific, concrete, and confident. Cite page titles inline
using [[page-slug]] markdown — those will be linkified on render.

CLUSTERS (by theme):
{{clusters}}

OUTPUT
- One opening paragraph (3 sentences) — the week's through-line.
- One paragraph per theme.
- A closing 1-sentence pointer to the most important single thing to
  read first.

No bullet points. No headings. No fluff.
```

### Display

- New eyebrow `BRIEFING · WEEK OF <date>` on the briefing page.
- Pinned at the top of the Codex sidebar under "This week".
- Linked from the digest email + push notification.

---

## Vision over inline images

When emails or saved URLs contain images that look meaningful
(hero, chart, screenshot), have a vision model describe them.

### Detection

Reuse the existing `EmailImage[]` structure plus the logo heuristic
boundary (`>360px` wide, alt text not "logo|wordmark|icon", not in the
first 1KB of HTML — those are content images, not branding).

### Pipeline

For each content image:

1. Fetch the image bytes server-side, with the same SSRF guards as
   plan 05.
2. Base64-encode and pass to the user's vision-capable provider:
   - Ollama: `llava` or `bakllava` model
   - Anthropic: Claude with `image` content blocks
   - OpenAI: `gpt-4o` / `gpt-4o-mini`
3. Prompt the model for a one-paragraph plain-language description.
4. Store on `Email.images[i].description` and surface in the page
   view as alt-text + on-hover popover.

Skip the call entirely when:
- The user's provider doesn't support vision (config check).
- The image is already described by a non-trivial alt attribute.
- Cost guardrails: cap at 5 images per email per day.

### Settings

Add to providers settings: `vision.enabled` (default false; opt-in
because it's a different cost profile from text generation).

---

## Cross-page synthesis

Given N pages, write a meta-page that cites each. Useful for "I have
12 GitHub Actions failure pages this week — write me a summary".

### Trigger

- Manual: in search results or any page list, "Synthesise selected"
  button. Opens a confirmation drawer with the chosen pages' titles
  and a prompt seed the user can edit.
- Programmatic: a rules-engine action `synthesise.into` (depends on
  plan 03) that fires when N pages share a tag.

### API

```
POST /api/pages/synthesise
{
  pageIds: string[],
  prompt?: string  // optional override
}
```

Returns SSE-streamed tokens; on completion, persists a new `Page` with
`groupingMode='synthesis'` and citations to each contributing page.

### Prompt

`synthesis.meta` (scope: new — `synthesis`):

```
Combine the wiki entries below into one coherent meta-entry. Cite
each as [[page-slug]] inline. Don't drop anything important; do drop
redundant phrasing across the source pages.

ENTRIES
{{entries}}

OPTIONAL FOCUS
{{focus}}
```

### Avoiding loops

A synthesis page links *to* its sources but is not itself a source for
future synthesis (filter by `groupingMode != 'synthesis'` in the
selector).

---

## Voice notes

Record a voice memo, transcribe, ingest as a page. Pair with TTS to
read the digest aloud on commute.

### Inbound: voice → page

- Record in-browser via `MediaRecorder` API. Send as `audio/webm` to
  the API.
- Worker dispatches to the user's transcription provider:
  - Ollama: `whisper`-class model via `/api/audio/transcriptions`
    (when supported)
  - OpenAI: `whisper-1`
  - Anthropic: not yet — fall back to OpenAI/Ollama if configured
- Persist as `Email` doc with `kind='voice'`, `text` from transcript,
  attachment list including the original audio bytes (so playback
  works from the page view).

### Outbound: digest → audio

- A "Listen" button on the home digest builds the day's lede +
  top-3 stories into a single string and hands it to a TTS provider:
  - OpenAI: `tts-1`
  - Eleven Labs: optional, requires API key
  - Browser: `SpeechSynthesisUtterance` fallback for the no-cost path
- Stream the audio to the browser; do not persist (it's ephemeral).

### Settings

`providers.transcription` and `providers.tts` blocks under settings,
mirroring the existing `generation` / `embedding` shape.

## Out of scope

- Live agentic tool use ("the LLM books me a meeting").
- Image generation. Not useful here.
- Per-user fine-tuning of any of these.

## Open questions

1. **Cost ceilings** — vision and TTS especially can run up bills on
   metered providers. Add a daily-spend cap per user, surfaced in
   settings, that disables vision/TTS for the rest of the day when
   exceeded.
2. **Briefing cadence** — weekly is the obvious default but some
   users will want monthly. Make cadence configurable; deferred unless
   asked.
3. **Synthesis editability** — the meta-page is regular wiki Markdown.
   Should it be locked? No; the user can edit it. Track the synthesis
   provenance in `Page.synthesisOf: ObjectId[]` so we can offer
   "Re-synthesise" if the underlying pages change.

## Verification

- Briefing: produces output with correct citations even when there
  are zero pages this week (graceful no-op edition).
- Vision: failures (image fetch error, provider doesn't support
  vision) degrade gracefully — image renders without a description,
  no broken page.
- Synthesis: re-running with the same inputs is deterministic at
  `temperature: 0`, idempotent.
- Voice: transcription stays on a per-user queue so a long file can't
  block another user's transcription.
