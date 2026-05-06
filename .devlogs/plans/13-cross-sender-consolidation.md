# Plan 13 — Cross-sender topic consolidation + incremental generation + merge detection

**Status:** Shipped.
Retrospective spec for the page-assignment pipeline as it stands after
the November 2026 commit series.

---

## The problem

A long-running story ("War in Iran", "Job Opportunities") gets emails
from many senders. Without consolidation each sender spawns its own
page; the wiki fragments into a dozen mostly-redundant pages with no
single canonical home for the topic.

## The solution, in three layered pieces

1. **Cross-sender topic match** in the assignment ladder, so a new
   email from a previously-unseen sender lands on an existing topic
   page when the embedding similarity + tag overlap warrant.
2. **Incremental generation** so an existing topic page doesn't get
   rewritten every time a new email arrives — the LLM folds the
   new dispatch into the existing prose, preserving user edits.
3. **Merge detection** as a safety net for when consolidation
   missed: after each page write, find near-duplicate pages and
   surface a "merge this into X?" prompt.

---

## 1. Assignment ladder

Steps 1–3 are the original sender-grouped path. Step 4 is new.

```
1. Thread match            (existing — match Reply-To threadKey)
2. Subject template + sender  (existing — same template, same from)
3. Sender + topic centroid (existing — same from, cosine ≥ 0.78)
4. NEW: Cross-sender topic match
5. Otherwise: spawn new page
```

### Step 4 gates
- Email's top topic must be **specific** (multi-word phrase OR
  hyphen/underscore compound OR ≥ 6 chars). Single short tokens
  ("ai", "war", "tax") never qualify.
- Candidate pool: (a) explicit topic-mode pages anchored on
  `primaryTopic` / matching alias, OR (b) bootstrap from existing
  sender pages with ≥ 2 distinct senders, tag overlap with the
  email, and the new email's sender NOT already on the page.
- Notification-stream pages excluded (those want to keep
  collapsing per-sender).
- Cosine similarity threshold **0.82** — stricter than within-sender
  (0.78) because mismerges across senders are particularly
  destructive.
- Tag/topic overlap required as a cheap structural pre-filter.

When a candidate qualifies, the page is **promoted to topic mode**
on first cross-sender hit (its `groupingMode` flips to `topic`,
`generationMode` to `incremental`). Subsequent emails on the topic
join via this same step 4.

### Files
- `apps/worker/src/services/pageAssignment.ts:findCrossSenderTopicMatch`
  — gate logic + cosine math.

---

## 2. Incremental generation

When `assignment.mode === 'topic'` AND the page already has
substantive content (≥ 200 chars) AND a prior `lastGeneratedFromEmailIds`
snapshot exists AND there are emails not in that snapshot →
**incremental**. Otherwise rebuild.

### Differences from rebuild

- Prompt: `consolidate.topic` seed instead of `generate.wiki-page`.
  Receives the existing `contentMd` plus only the new emails since
  the snapshot.
- Email selection: just the new ones, no elision. The existing
  prose carries the older context.
- Citation labels continue past the highest existing label so
  `[eN]` markers in preserved prose still resolve.
- LLM output schema: `PageMergeDraft` (extends `PageGenerationDraft`
  with `topicAliases`).
- Citations + topic aliases merge into the persisted page rather
  than replacing.
- `primaryTopic` set on first run, stays stable.

### Page schema additions

```
topicAliases: [String]          — synonyms ("Iran war" ↔ "Iran-Israel conflict")
lastGeneratedFromEmailIds: [ObjectId]
generationMode: 'rebuild' | 'incremental'
```

### Files
- `apps/worker/src/processors/generatePage.ts` — branches on
  `useIncremental` for prompt + persistence.
- `packages/llm/src/seed/index.ts` — `consolidate.topic` seed.
- `packages/shared/src/schemas/page.ts` — `PageMergeDraft`.

### UI

`Page.tsx` Attribution strip surfaces topic-mode pages distinctly:
"Topic page · 12 messages from 5 senders · evolving" instead of the
sender-anchored copy.

---

## 3. Merge detection

After every page write, `apps/worker/src/services/mergeDetect.ts:findMergeSuggestions`:

1. Pulls 200 most-recently-updated user pages (excluding briefings
   and synthesis pages).
2. Filters to those with cosine ≥ 0.85 to the just-saved centroid.
3. For the top-3 candidates, runs the existing `dedupe.detect` LLM
   check.
4. Persists confirmed near-duplicates onto `Page.mergeSuggestions[]`
   with score, reason, and timestamp.

### Schema

```
Page.mergeSuggestions: [{
  pageId, score, reason,
  suggestedAt: Date,
  dismissedAt: Date | null    // sticky once set
}]
```

### API

```
POST   /api/pages/:id/merge
       — fold source into target. Unionises sourceEmailIds /
         threadKeys / senderAddresses / subjectTemplates /
         topicAliases (source title becomes alias). Repoints
         Email.pageId. Switches target to topic+incremental.
         Enqueues a regen job anchored on newest contributing
         email. Deletes source page + revisions.
DELETE /api/pages/:id/merge-suggestions/:targetId
       — record dismissedAt timestamp; never re-suggest the pair.
```

### UI

`MergeBanner` in `Page.tsx` between attribution strip and main
banners. Yellow banner with one row per suggestion: candidate title
(links), summary, LLM reason, confidence %, Merge / Dismiss
buttons. Confirm dialog spells out the destructive nature.

---

## Failure modes / edge cases

- **Wrong-merge severity is high** — that's why every threshold and
  gate is stricter than within-sender clustering. Audit comments in
  `pageAssignment.ts` lay out the rationale per gate.
- **Bootstrap can promote unsuited pages.** Mitigated by:
  notification-stream exclusion, ≥ 2 senders requirement, tag
  overlap requirement, cosine ≥ 0.82.
- **Incremental + user edits** — the consolidate prompt is told
  explicitly to preserve existing prose unless contradicted. Real
  test of this is qualitative; no unit test catches a regression.
- **Merge action is destructive.** Confirmed via dialog; no undo.
  Dismissal is the no-op alternative for false positives.
- **Briefing / synthesis pages skip merge-detection** by
  `groupingMode` filter — those exist intentionally as
  consolidations themselves.

## What's deliberately not here

- **Manual "force topic-mode this page"** action. Could land in
  Settings → Tags or as a per-page action; would let users
  promote a page that didn't qualify for cross-sender match.
- **Topic-timeline right-rail card** (when each sender contributed)
  — flagged in the original cross-sender design as nice-to-have,
  not yet built.
- **Manual "split this topic page"** action — once consolidated
  there's no UI to break a multi-sender page back into per-sender
  pages.
