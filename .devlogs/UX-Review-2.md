# UX Review #2

A second-pass UX audit of the Rose SPA, performed against the
codebase at `6660d63` — well downstream of where Review-1 (`e9c4c56`)
landed. Six substantial new surfaces have shipped since then:
ResearchButton, the Diagnostics dashboard, the Codex → Web sources
tab, the Topic-research card in Settings → Daydream, the Watch
deepResearchAfter checkbox, plus the Sender ▾ menu collapse. On
top of that, every Review-1 prioritised fix is now in: ConfirmModal
adoption, Skeletons, KeyboardHelp, error humanizer, vocabulary
unification, Codex tab scroll, lazy images, route memoisation, the
`md:` two-column breakpoint, and aria-current.

This pass looks for two things: rough edges on the new surfaces,
and any regressions that the Review-1 fixes introduced.

> **Scope:** `apps/web/src/{routes,components,lib,Shell.tsx}` plus
> the new metric/diagnostics + web-document API surfaces where they
> shape UI behaviour.

Author: Claude. Verified findings only — claims that turned out to
be incorrect under check (e.g. "tablet breakpoint regressed" and
"BackgroundNoteCard still uses raw confirm()") were dropped before
synthesis.

---

## TL;DR

Most of the polish from Review-1 actually landed and reads cleanly.
Confirmation flow adoption is at ~90% — the three remaining
holdouts are deliberately low-stakes. Skeletons ship on every named
route. The KeyboardHelp modal works. The vocabulary rename held.
The `md:` two-column breakpoint correctly puts the right rail in
play on tablets.

The new feature surfaces have a smaller blast radius:

1. **The Watch builder's `deepResearchAfter` checkbox is silently
   gated.** A user can check it, save the watch, and only discover
   at run-time that the master `webResearch.enabled` toggle in
   Settings → Daydream was off. The fix is a save-time check or an
   inline warning when both flags don't agree.
2. **The Codex → Web sources "Skip + delete cached" button has no
   confirmation.** It deletes every WebDocument for a host. It
   should go through ConfirmModal with a destructive treatment
   (the same shape as the Page delete dialog).
3. **The Sender ▾ menu's status pill is too subtle.** A blocked /
   trusted / muted state shows up as `(blocked)` text inside a
   ghost-styled button, which reads as decoration. A solid badge
   or color-coded dot would surface the state at scan time.

The single carryover from Review-1 is **right-rail density on
`/p/:slug` (9 cards, uniform weight)** — that recommendation didn't
land. Worth doing before the article view picks up another card.

Nothing in this pass is critical. No flow is blocked, nothing
loses data, and the dashboard functions. The list is polish on the
new surfaces and one real correctness gap (the silent watch gate).

---

## 1. New surface — `<ResearchButton>`

`apps/web/src/components/ResearchButton.tsx`. Three states: idle
("Research"), in-flight ("Queued…" / "Researching…"), idle-with-
last-fetched ("Researched 3m ago"). Auto-polls every 5s while in
flight, invalidates the page query on completion.

### Reads well

- The 5s `refetchInterval` only ticks while in flight (function
  form on `refetchInterval`); flips off when state returns to idle.
  No background tab thrash.
- `staleTime: 4_000` keeps the pill from flickering during the
  queued→running transition.
- 403 fork to Settings → Daydream is helpful — a structured
  "topic research is off, open settings?" confirm rather than a
  raw error toast.

### Findings

- **`ResearchButton.tsx:106`** — When `inFlight`, the pill is
  styled with `border-rose-300 bg-rose-50` matching the
  Featured-tag pill on `/t/:tag`. It's a good visual rhyme but
  reads to a first-time user as "this is highlighted because it
  matters" rather than "this is currently working." Worth
  considering a slate / blue tint to encode "in progress" rather
  than "important." *Low.*
- **`ResearchButton.tsx:131`** — Idle-with-`lastResearchedAt` button
  shows the relative time + a `Globe` icon, not a refresh affordance
  in the visual itself. The hover hint says "click to refresh" —
  good — but a `RefreshCw` icon next to the time would make the
  re-runnable nature obvious without the hover. *Low.*

---

## 2. New surface — Settings → Diagnostics

`apps/web/src/routes/settings/Diagnostics.tsx`. Admin-only.
Three headline Stat cards, Mongo status block, per-queue table
(non-zero traffic only), per-worker rollup with collapsible
counters/histograms. Auto-refreshes every 10s.

### Reads well

- The "non-zero traffic only" filter on the queues table is the
  right call — 24 queues, most idle in any given minute, would
  have been visual noise.
- Per-worker mode badge + RSS + heap + loop p95/max gives a
  five-second answer to "is the worker keeping up?".
- Histograms / counters tucked under `<details>` keeps the page
  scannable.

### Findings

- **`Diagnostics.tsx:103`** — Loading state is plain "Loading
  diagnostics…" text, not a Skeleton. Inconsistent with the
  pattern Review-1 established. Operator-facing so low blast
  radius, but it's the one route that obviously skipped the
  conversion. *Low.*
- **`Diagnostics.tsx:147`** — The "Last updated" timestamp uses
  `toLocaleTimeString()` only; on a long-open dashboard the user
  loses the date context. Switching to a relative ("3s ago")
  would also make the auto-refresh visible. *Low.*
- **No empty state for "no workers."** When the dashboard renders
  before any worker has published its first 30s snapshot, the
  per-worker section says "No worker snapshots — either nothing's
  running or the publishers haven't ticked yet (every 30s)." Good
  copy. But the queue table renders empty too with no equivalent
  explanation. Add a "queues idle" hint when the filter empties
  the table. *Low.*

---

## 3. New surface — Codex → Web sources tab

`apps/web/src/routes/Codex.tsx:WebSourcesTab`. Per-host
collapsible cards with sample URL list, two-button forget per
host, separate "denied hosts (no cached docs)" section.

### Reads well

- The breakdown numbers (doc count, on-topic count, last fetch,
  avg relevance) answer the "is the budget going where I expect"
  question without drilling in.
- Color-coded relevance score badges (emerald for on-topic, ink
  for off) make the per-URL list scannable.
- Recursion depth ("depth 1") shown only when > 0 keeps the
  default view uncluttered.
- "Allow Again" affordance for previously-blocked hosts closes
  the loop — no orphan denylist entries with no way back.

### Findings

- **`Codex.tsx` — "Skip + delete cached" has no confirmation.**
  It deletes every WebDocument for a host. The button has a
  helpful tooltip but no second-step gate. Route through
  `useConfirm` with a destructive treatment — the cache count
  in the body copy ("Delete N cached pages from this host? They
  rebuild on the next research run.") is plenty. *Medium.*
- **No bulk action.** A user with 50+ hosts and a sense of "I
  want to keep these five and nuke the rest" has to click through
  every row. Probably a Phase-3-polish item; not worth shipping
  until someone hits it. *Low.*
- **Empty-state copy is good but missing on first load**: the
  empty-state text only renders when both `hosts.length === 0`
  AND `allBlocked.length === 0`. If the user has a deny entry but
  no cached docs (e.g. they blocked something via the Settings →
  Daydream `denyHosts` field directly), the page renders only the
  "denied hosts (no cached docs)" section with no surrounding
  context. *Low.*

---

## 4. New surface — Settings → Daydream → Topic research card

`apps/web/src/routes/settings/Daydream.tsx` — new card below the
existing externalSearch section. Enable toggle + per-run fetch
budget + topic threshold + daily fetch budget.

### Reads well

- Card placement under externalSearch is correct: the egress
  explainer just above it covers the privacy posture, and the
  three numeric inputs that appear when enabled are bounded with
  per-input range guards.
- Default values are sensible (25 / 0.55 / 200) and match what
  the topicResearch worker uses.

### Findings

- **`Daydream.tsx:557` — the topic research card competes with
  the surrounding Daydream config for visual weight.** The Daydream
  page is already long; the new card sits at the same `card` level
  as the Sources / ExternalSearch / Skip cards. From a user's
  perspective, "topic research" is conceptually a level above
  Daydream's existing per-source toggles — it's its own feature
  using Daydream as a delivery channel. Consider a stronger visual
  separator (a section header with `<hr>` + a brief paragraph
  explaining the relationship to Daydream) so the user understands
  it's a distinct feature, not just another Daydream source. *Low.*
- **`Daydream.tsx` numeric input grid (line ~605)** — Three side-
  by-side number inputs (per-run budget, topic threshold, daily
  budget) read at uniform visual weight even though they have
  very different meanings. Topic threshold is the algorithmic
  cutoff (rare to change); the budgets are the safety levers.
  Group the threshold into an "Advanced" details disclosure or
  give the budget inputs more prominent labels. *Low.*

---

## 5. New surface — Watch builder `deepResearchAfter` checkbox

`apps/web/src/routes/TopicWatches.tsx:413` — checkbox under the
existing `includeNewsSearch` toggle.

### Findings

- **High: gating is silent.** The checkbox copy says "Requires
  *Topic research* to be enabled in Settings → Daydream." But if
  the user checks the box and `webResearch.enabled` is false, the
  watch saves successfully and only fails at runtime — the worker
  no-ops the deepResearch step silently. The user doesn't see an
  error; the watch just never seems to upgrade. **Recommendation:**
  fetch `/api/daydream` on the form mount, and if
  `webResearch.enabled === false`, render the checkbox in a
  disabled state with an inline link to Settings → Daydream
  ("Enable Topic research first"). Re-enable when the upstream
  setting flips on. *High.*
- **`TopicWatches.tsx:413` — copy is dense.** The five-line
  explainer covers cost + dependency + behaviour, which is the
  right information, but it's a wall of text. Split into a
  one-line summary ("Re-synthesises with full citations after
  each fire") and a `<details>`-revealed tradeoff paragraph.
  *Low.*

---

## 6. New surface — Sender ▾ menu

`apps/web/src/routes/Email.tsx:639` — collapses Mute / Block /
Trust into one dropdown trigger that surfaces the current state.

### Reads well

- The single-trigger collapse fixes the Review-1 toolbar-density
  issue. Email toolbar fits one row on phones.
- ConfirmModal handles Block + Trust changes with appropriate
  destructive treatment.

### Findings

- **`Email.tsx:646` — the status indicator is too subtle.** When
  the sender is blocked / trusted / muted, the trigger button gets
  state-coloured *text* (`text-red-700` / `text-emerald-700` /
  `text-amber-700`) plus a small `(blocked)` / `(trusted)` /
  `(muted)` parenthetical. Inside a `btn-ghost` (transparent
  background) this reads as decoration; the user has to read the
  parenthetical to know the state. **Recommendation:** keep the
  icon + label as-is, replace the parenthetical with a solid
  pill-shaped badge to the right of the chevron (e.g. red bg +
  white text "BLOCKED"). *Medium.*
- **`Email.tsx:670` — when no state is active, the button shows
  just "Sender ▾" with no affordance hint.** New users don't know
  what's behind the menu. A small status indicator (a green dot
  for "no state set" or a tooltip on the trigger) would help.
  *Low.*

---

## 7. ConfirmModal adoption — completeness check

Review-1 audit ran 90% of the destructive flows through
ConfirmModal. The remaining holdouts:

### Findings

- **Codex → Web sources Skip + delete cached** — already covered
  in §3. *Medium.*
- **Quarantine rescue** (`Quarantine.tsx:51`) — still no
  confirmation, no undo toast. Action is constructive (un-flag a
  page) so low risk, but it's the only place a state-change
  doesn't ask. Consistency-wise should at least show a toast with
  an undo button. *Low.*
- **`ConfirmModal.tsx:156` — Enter-key behaviour is inconsistent.**
  In a `prompt` request, plain Enter submits. In a `confirm`
  request, plain Enter does nothing (only Cmd/Ctrl+Enter
  submits). The asymmetry is intentional (a stray Enter shouldn't
  fire a destructive button the user hasn't focused) but it
  surprises — first-time users hit Enter expecting submit. **Fix:**
  for non-destructive confirms, allow plain Enter; for destructive,
  keep Cmd/Ctrl+Enter. *Medium.*

---

## 8. Skeletons — coverage check

Skeletons confirmed on Home, Page, Email, Search, Quarantine —
all five from Review-1 recommendation #4. Diagnostics is the one
new route that didn't get one (§2 above).

### Findings

- **Page-load skeleton looks great on `/p/:slug`.** Title bar +
  metadata row + body card + right rail all match the actual page
  shape. *No action.*
- **Search skeleton is a stack of three identical cards** — could
  vary the heights slightly to avoid the "obviously fake" feel,
  but functional. *Low.*

---

## 9. KeyboardHelp modal

`apps/web/src/components/KeyboardHelp.tsx`. `?` opens it; lists
every chord grouped into Navigation / Actions / Misc.

### Findings

- **No discoverability hint.** `⌘K` has a visible "Palette" button
  in the top-right; `?` has nothing equivalent. New users can't
  find the help unless they happen to type `?`. **Fix:** add a
  small "?" icon button next to the Palette button — same shape,
  routes to `setHelpOpen(true)`. *Low.*
- **Modal is comprehensive but listed as one big grid.** A search
  input at the top would be premature given the modest count, but
  worth revisiting if the registry grows past 30 chords. *Low.*

---

## 10. Right-rail density carryover from Review-1

`/p/:slug` — 9 reference cards stacked vertically (Attribution,
Sources cited, PageExtras, Places, Mentions, Topics, Images,
Links, Attachments), all uniform `card`-styled.

### Findings

- **Carryover from Review-1 #5 — not addressed.** The
  recommendation was to collapse the lower five into a single
  `<details>`-driven "Reference" group, or regroup by purpose
  (provenance / extracted content / links). On a typical page
  the right rail is a long scrollable column where each card
  competes equally with the next. **Recommendation:** group as
  Provenance (Attribution + Sources) / Extracted (Mentions +
  Topics + Places + Entities) / Links (Links + Attachments +
  Images), each with a section header and the lower-traffic
  groups collapsed by default via `<details>`. *Medium.*

---

## 11. Internal vocabulary drift

User-facing copy correctly says Block / Mute / Trust. Internal
identifiers (TypeScript variable names, API field paths,
mongoose schema keys) still use `whitelistedSenders`,
`whitelistSender`, `unwhitelistSender`. Stable internal naming
is fine; the risk is that future PRs add more `whitelist*`
identifiers and the gap widens.

### Findings

- **`Email.tsx:70`, `User.ts:settings.daydream.webResearch`** —
  Internal identifiers stable; not worth a rename. Worth adding a
  comment in `User.ts` noting "user-facing copy says Trust; the
  field name is historical" so the next person who touches it
  doesn't add yet another variant. *Low — documentation only.*

---

## 12. Findings unrelated to a specific surface

- **`apps/web/src/lib/api.ts:humaniseError`** — the audit didn't
  find any error-toast site that bypasses it. *Good ship.*
- **`apps/web/src/components/Shell.tsx:239`** — `aria-current="page"`
  on NavLink is set explicitly. NavLink v6 also sets it
  automatically when active; the explicit prop tells NavLink which
  attribute value to use. Correct. *No action.*
- **The Skeleton component's `role="status" aria-label="Loading"`
  may double-announce in screen readers** when multiple skeletons
  render at once. Tested on the Home skeleton (three SkeletonCard
  + a SkeletonLines stack — six total). Worth setting `aria-label`
  only on the wrapping `<div role="status">`, not each leaf
  Skeleton. *Low.*

---

## Recommendations, prioritised

1. **`high` — Watch builder gating** (§5). Fetch
   `webResearch.enabled` on form mount; disable the
   `deepResearchAfter` checkbox with an inline link when off. The
   only correctness gap in this review.
2. **`medium` — Codex → "Skip + delete cached" confirmation** (§3).
   Route through `useConfirm` with destructive treatment.
3. **`medium` — Sender ▾ status badge upgrade** (§6). Solid pill +
   icon dot replaces the parenthetical text.
4. **`medium` — ConfirmModal Enter handling** (§7). Allow plain
   Enter for non-destructive confirms, keep Cmd/Ctrl+Enter for
   destructive.
5. **`medium` — Right-rail card grouping on `/p/:slug`** (§10).
   Three sections, lower-traffic groups collapsed.
6. **`low` — Diagnostics Skeleton + relative-time timestamp** (§2).
7. **`low` — KeyboardHelp discoverability button** (§9).
8. **`low` — Daydream Topic-research card visual hierarchy** (§4).
9. **`low` — TopicWatches deepResearchAfter copy split** (§5).
10. **`low` — Internal `whitelist*` naming comment** (§11).

Total estimated effort for items 1–5: half a day. Items 6–10:
another half-day. Skip the rest if you don't have bandwidth.

---

## What works well that didn't before

This pass deliberately skips most of Review-1's findings because
they shipped. Worth naming the wins:

- **ConfirmModal everywhere it matters.** Page delete needs typed
  "delete"; Email block has a structured destructive copy;
  DraftReply send asks before firing; Search "Save as" goes
  through the modal's prompt variant. The browser-native
  `confirm()` dialogs are gone from every flow that's user-
  visible.
- **The `?` keyboard shortcut works.** Open the help modal,
  every binding is documented.
- **Skeletons read as deliberate.** The Page skeleton in
  particular — title + metadata + body block + sidebar — does
  exactly what Review-1 asked for.
- **The `md:` breakpoint on Email and Page actually puts the
  right rail in play on tablets.** iPad portrait gets the
  two-column layout it deserves; the right rail's value is no
  longer locked to desktop-only.
- **Vocabulary unification held.** No surface still says
  "Whitelist" or "Mark spam" in user-facing copy.
- **Codex tab scroll-to-top works.** The annoying "you switched
  tabs and ended up halfway down" issue from Review-1 is gone.
- **NavLink `aria-current` lands.** Screen readers announce the
  current location.

---

## Out of scope for this review

- Visual design (typography, palette, spacing). Tailwind preset
  reads well; no obvious wins.
- Performance perception. Phase E covered most of this; revisit
  after a flame graph if anything's still sluggish.
- The Diagnostics dashboard's information architecture if it
  grows past the current ~3-section shape. Today's content fits
  on one page.
- Mobile-first responsive review. Review-1 did this; nothing
  meaningful regressed.
- Internationalisation. Still not in scope.

---

*Review by Claude. Generated against the snapshot at `6660d63`.
The verifications I ran while writing dropped two agent claims that
were incorrect under check (the `md:` breakpoint and the
`BackgroundNoteCard.confirm()` finding). Re-run after items 1–5
land to re-baseline.*
