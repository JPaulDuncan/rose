# ADR 0005 — The LLM never fetches the web; tools do

## Status
Accepted, 2026-05-04.

## Context
Several features want the worker (or API) to incorporate live data from
the public internet into LLM output: weather (NOAA), Daydream
(Wikipedia), URL ingestion (any public page), and adapters that haven't
been built yet (Wiktionary, Stack Exchange, arXiv, …).

The failure mode we want to design out: the LLM is given a freeform
prompt that includes "look up X on the internet and summarise it",
producing an answer. Without a real fetch the model invents the
answer. Even when the prompt does include fetched data, weak/small
local models will drift off the data and write plausible-looking
prose that contradicts the numbers.

The weather brief shipped this way originally — the LLM was given a
NOAA forecast JSON blob and told to "use ONLY the JSON below". When
running against a small Ollama model the brief regularly invented
temperatures and conditions, which is exactly the problem this ADR
is here to prevent.

## Decision

**External data comes from typed tools, not from the LLM.** Three
rules, in order of priority:

1. **Server-side `webFetch` is the only path to the public internet.**
   It lives in `packages/llm/src/web/` and is callable from both API
   and worker. It enforces:
   - SSRF guard (`assertSafeHttpUrl`): no loopback, private IPs, link-
     local, cloud-metadata, or non-HTTP schemes. DNS-rebinding-safe.
   - Standard contactable User-Agent.
   - Per-call timeout (default 8s).
   - Pluggable Redis cache for GETs (default 7d TTL), keyed by
     `caller + method + url + accept` so distinct features don't
     collide.
   - `webFetchJson(url, { schema })` adds Zod validation on top so a
     hijacked endpoint or response-shape change becomes a typed
     parse error rather than a downstream `undefined` crash.

   Code that needs more (redirect-by-hand revalidation, byte-cap
   streaming, etc — currently `apps/worker/src/lib/safeFetch.ts`'s
   `safeFetch` for URL ingestion) re-exports `assertSafeHttpUrl` from
   `@rose/llm` so the SSRF policy stays in one place.

2. **The LLM is a synthesiser, not a fetcher.** Whenever an LLM call
   includes data from the public internet, the worker fetches it
   first via webFetch, then passes the *parsed, validated* result
   into the prompt as labelled data. The system prompt explicitly
   states that fetched content is data, not instructions, to harden
   against prompt-injection in third-party content.

3. **Prefer deterministic transforms over LLM narration where
   possible.** When the input is already structured (NOAA periods,
   feed entries, API responses), a hand-written formatter is more
   reliable, faster, free, and impossible to hallucinate against.
   Use the LLM only when the synthesis genuinely requires natural-
   language reasoning over unstructured text (Daydream's "encyclopedic
   summary from Wikipedia prose" is a fair use; "weather brief from
   typed JSON" is not).

## Consequences

- **Weather brief is deterministic now.** `buildDeterministicBrief`
  in `apps/api/src/routes/weather.ts` reads NOAA periods directly
  and assembles a one-liner. No LLM call, no chance of drift, no
  cost, sub-millisecond. The seed instruction `weather.brief` is
  retained but unused; future use cases that genuinely need narrative
  weather (e.g. a long-form newsletter intro) can opt in by name.

- **Daydream's Wikipedia adapter routes through `webFetchJson`** with
  a Zod schema for both `/search/title` and `/page/summary`. The
  Adapter context's optional `cache` knob is forwarded through so
  the same Wikipedia page lookups across many users / pages costs
  one upstream call.

- **`webFetchJson<T>` is the recommended call shape** for any new
  external API integration. Pass a Zod schema, get `T | null` back,
  handle the null. No bare `fetch` for external URLs in API/worker.

- One canonical `UnsafeUrlError` class in `@rose/llm` — the worker's
  `safeFetch.ts` re-exports it so `instanceof` works cross-package.

- The cache is best-effort (read errors don't block the network
  path; write errors don't block the response). A Redis blip
  degrades to "uncached fetch", not "request failure".

## Out of scope

- LLM-driven function/tool-calling loops (the model decides which
  tool to invoke, tool result feeds back into the next turn). That
  shape is a future story for chat / Ask-the-wiki when we want
  multi-step reasoning. Current adapters and features are one-shot:
  fetch, then synthesise, no loop.

- Per-tenant egress controls beyond what user settings already
  provide (e.g. corporate proxy, custom egress allowlists). The
  SSRF guard and per-source toggles in Daydream cover the v1 case.
