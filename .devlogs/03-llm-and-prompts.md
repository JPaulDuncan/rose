# 03 — LLM Integration & Prompt Registry

## Ollama client

`packages/llm/src/client.ts`:
- `generateStream({model, prompt, system, format, temperature})` — async iterator over
  `{response, done}` chunks. We pass `format: 'json'` for structured output.
- `embed(model, input)` — returns `number[]`.
- `listModels()` — used by the readiness check and the (planned) model picker.

The streaming loop tolerates partial frames (Ollama occasionally emits split JSON lines
during shutdown) by parsing line-by-line and skipping malformed entries.

## Prompt registry

A user owns a set of `instructions`. Each instruction has:

| Field | Notes |
| --- | --- |
| `scope` | `parse` \| `categorize` \| `generate` \| `link` \| `dedupe` |
| `template` | Mustache-lite (`{{var}}`) string |
| `variables[]` | Auto-inferred if omitted |
| `isSystem` | Read-only system seed; clone to customize |
| `isDefault` | Exactly one default per `(userId, scope)`; enforced in API |

System seeds live in `packages/llm/src/seed/index.ts`. On registration the API runs
`seedSystemInstructionsForUser(userId)` so every user starts with a working chain.

## Generation contract

`generate.wiki-page` instructs the model to return JSON matching `PageGenerationDraft`:

```ts
{
  title: string,             // 1..200 chars
  summary: string,           // ≤ 280 chars
  contentMd: string,
  tags: string[],            // ≤ 10
  suggestedCategory: string | null
}
```

The worker validates with Zod. On parse failure we throw, BullMQ records the failure,
and retry kicks in. The system prompt repeats "JSON only" because some local models
ignore `format: 'json'` for the first few tokens otherwise.

## Why JSON, not free-form

- Structured output is round-tripped into Mongo with no fragile post-hoc parsing.
- Easy to A/B different prompts: change the template, keep the schema, downstream
  logic untouched.
- Embedding is computed on `title + summary + contentMd`, which is independent of
  model output formatting.

## Cancellation

`OllamaClient` accepts an `AbortSignal`; the `IngestionDrawer` exposes a cancel button
that aborts the underlying SSE stream. The worker is currently fire-and-forget and does
not honor cancellation — wiring `AbortSignal` into the BullMQ job is on the roadmap.
