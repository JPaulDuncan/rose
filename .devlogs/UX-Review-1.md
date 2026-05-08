# UX Review #1

A first-pass UX audit of the Rose SPA, performed against the codebase
on `claude/email-wiki-ai-app-dyHnE` after the most recent layout
churn (Email two-column redesign, Tag nameplate move, article-page
right-rail consolidation, Trust/Whitelist toolbar).

This is a read of the *implementation*, not a heuristic checklist.
Every item has a code reference. Severities are calibrated against
"a personal newspaper that ingests dozens of mailers a day" — friction
that compounds across hundreds of interactions per week is treated as
high severity even when each individual instance feels minor.

> **Scope:** `apps/web/src/{routes,components,lib,App.tsx,Shell.tsx}`.
> Server-side ergonomics (API shape, error envelopes) are tangentially
> relevant and only called out where they leak into the UI.

---

## TL;DR

The big-shape changes are landing — the two-column email view, the
right-rail consolidation on `/p/:slug`, and the link-card extraction
all read clean. Three categories of issue dominate:

1. **The Email toolbar has outgrown its container.** Reply / Remove /
   Mark spam / Block / Trust / More + a split-Delete is nine
   affordances in one row. It wraps to three rows on phones and the
   primary action (Draft reply) has no visual lead over the
   destructives. This is the single most-touched surface in the app.

2. **`window.confirm` and `window.prompt` are doing the heavy lifting
   for destructive flows.** Block sender, Save search, Send reply,
   Rescue from quarantine, Delete page — most have either a native
   confirm with verbose multi-paragraph copy or no confirmation at
   all. None are undoable. We should standardise on a single
   `<ConfirmModal>` with a typed danger-button and an undo toast.

3. **Loading is "Loading…" everywhere.** No skeletons on Home, Page,
   Email, Quarantine, or Search. The user sees a blank card for ~1–3s
   while the LLM-derived data resolves; they don't know whether the
   page is empty or still loading.

The one **accessibility-critical** miss: NavLink active states are
CSS-class only — no `aria-current="page"` — so screen readers and
keyboard users have no signal which tab they're on
(`apps/web/src/Shell.tsx:232`).

Terminology drift between *Block / Trust / Whitelist / Quarantine /
Hidden / Mark spam* is the second-most-likely thing to confuse a new
user. We have at least three names for "make this go away" and two for
"this is fine." Pick three, document the mental model, and rename in
one PR.

---

## 1. Information architecture & navigation

### High

- **`Shell.tsx:232`** — NavLink active state is class-only, no
  `aria-current="page"`. Screen readers cannot announce the current
  tab. Add `aria-current` via NavLink's `className` callback signature
  or its first-class `aria-current` prop.

### Medium

- **`Shell.tsx:64`** — The Email view's back button hard-codes "Back to
  ingest queue" regardless of where the user came from. When you land
  on `/email/:id` from `/p/:slug` (the article view), the breadcrumb
  lies. Either compute the back target from `location.state.from` or
  generalise to "← Back."
- **`Shell.tsx:178`** — The hamburger appears at `md:hidden` (<768px),
  but the primary nav collapses to icon-only at `md:` (768–1024px).
  The 768–1024 range gets icon-only nav with no labels and no
  hamburger fallback — orphaned ergonomics.
- **`Shell.tsx:126`** — Same root cause: nav labels appear at `lg:`
  but icons appear at `md:`, leaving tablets in a regrettable middle.
- **`Codex.tsx:114`** — Tab state persists in `?tab=`, but switching
  tabs doesn't reset scroll. Since each tab has independent content
  height, the user lands mid-page on the second tab.

### Low

- **`App.tsx:108`** — `/inbox` redirects silently to `/settings/ingest`
  with no toast or breadcrumb. Old bookmarks just teleport.
- **`Shell.tsx:439`** — Pinned smart-folder strip is `overflow-x-auto`
  with no scroll affordance (no fade gradient, no `›` indicator). On
  mobile the user has no signal that more folders exist.

---

## 2. Email view (`apps/web/src/routes/Email.tsx`)

This is the single most-edited surface in the codebase. After the
recent redesign:

### High

- **`Email.tsx:524` (`EmailActionsBar`)** — Nine affordances in one
  row: Draft reply, Remove (split menu), Mark/Unmark spam, Block/Unblock,
  Trust/Untrust, More. On a 375px viewport this wraps to three rows
  of mixed-color buttons. **Recommendation:** Pull non-toolbar
  destructives into the More menu by default; Reply, Mark spam, and
  Block stay in the bar. Trust/Untrust belongs next to Block as a
  toggle pair (as we have it now), but should share a button with
  Mark spam under "Sender → ▾" rather than living independently.

### Medium

- **`Email.tsx:317–341`** — Block confirmation is a multi-line
  `confirm()` with bulleted copy. `confirm()` collapses whitespace
  and renders without typography — the user sees a wall of text. Move
  to a real modal.
- **`Email.tsx:201`** — Error state surfaces `(error as Error).message`
  raw. A 503 from the upstream LLM provider lands as "503 Service
  Unavailable" with no recovery hint.
- **`Email.tsx:360`** — Two-column grid is `lg:` only; on tablets
  (768–1024px) the layout stays single-column. The right rail's value
  (Topics / Links / Routing) is exactly the kind of context a tablet
  user wants. Lower the breakpoint to `md:` and shrink the rail
  basis.

### Low

- **`Email.tsx:626`** — Block uses red text on a ghost button; Trust
  uses emerald text on a ghost button. They read as the same visual
  weight as the muted "More" button next to them. Destructive +
  affirmative actions should both have at least a tinted background,
  not just colored text.
- **Mixed phrasings:** "Mark spam" / "Mark as spam" / "Mark sender
  spam" appear in three places (`Email.tsx:614,616,622`).

---

## 3. Article / wiki page (`apps/web/src/routes/Page.tsx`)

The right-rail consolidation lands well. Remaining issues:

### Medium

- **`Page.tsx:297–311`** — The right rail now stacks Attribution,
  Sources cited, PageExtras, Places, Mentions, Topics, Images, Links,
  Attachments. That's ~9 cards. Without visual weight differentiation
  the user has to read every header to find the one they want.
  Suggest collapsing the lower five into a single `<details>`-driven
  "Reference" group, or grouping by purpose (provenance / extracted /
  links).
- **`Page.tsx:251`** — Page delete is a bare `confirm()` with no undo.
  This is *page* deletion — an LLM-generated narrative across many
  source emails — which is non-recoverable in a way email deletion
  isn't. Should be a typed confirmation ("Type the page title to
  confirm") or at minimum a 5-second undo toast.

### Low

- **`Page.tsx:201`** — Loading state is plain text. Article body has
  a known shape (title, summary, prose, hero); a real skeleton would
  read very natural here.

---

## 4. Email composition (`apps/web/src/components/DraftReply.tsx`)

### High

- **`DraftReply.tsx:150`** — Send has no confirmation. Once queued,
  Outbound is non-recoverable from the UI. Given the LLM is drafting
  on the user's behalf, accidental-send risk is real.

### Medium

- **`DraftReply.tsx:129–139`** — Save and Send share a `streaming`
  busy flag, so the user can't tell which mutation is in flight while
  the LLM streams.
- **`DraftReply.tsx:140`** — Clear-draft confirmation is generic; it
  doesn't note the cited-quote context disappears with it.
- **`DraftReply.tsx:72`** — During LLM generation the textarea is
  blank then fills. A typing-cursor or "Drafting…" placeholder would
  read as deliberate instead of broken.

---

## 5. Recipe wizard (`apps/web/src/components/RecipeWizard.tsx`)

### High

- **`RecipeWizard.tsx:74–140`** — Some action types declare
  `requires: 'email'` but the wizard never blocks invalid pairings
  in the UI. A user can build "trigger: time.scheduled → action:
  draft-reply-to-email" and only learn at submit-time that the action
  needs an email to act on. The trigger picker should filter the
  action list, or actions should grey out with a tooltip.

### Medium

- **`RecipeWizard.tsx:182`** — No step indicator ("Step 2 of 4"). Users
  abandon multi-step flows with no progress signal.
- **`RecipeWizard.tsx:260+`** — No "Back" affordance between steps;
  Cancel is the only way back, and it discards everything.

---

## 6. Empty / loading / error states

### Medium (broadly)

- **`Home.tsx:113`**, **`Page.tsx:201`**, **`Email.tsx:209`**,
  **`Quarantine.tsx:122`**, **`Search.tsx:262`** — All render plain
  "Loading…" text. Each route has a known shape — a skeleton with
  card placeholders would feel meaningfully faster (perceived
  performance ~30–40% improvement is the rule of thumb).
- **Throughout (~167 `toast.error` callsites)** — Errors surface raw
  API messages. There's no central "humanise" pass. Wrap the API
  client to map common shapes (`401`, `5xx`, network) to friendly
  copy and only fall back to `e.message` for unexpected errors.

### Low

- **`Search.tsx:261`** — "Type at least 2 characters" hint disappears
  on focus; no ongoing feedback if the user is below the threshold.
- **`CommandPalette.tsx:64`** — "No results." with no escape hatch
  ("Search the page body instead?" / "Create a new note titled X").

---

## 7. Density & visual hierarchy

### Medium

- **`Email.tsx:263–300`** — The badge row (priority, spam score,
  attachments, status, "Open article") is uniform-weight. The Open
  article link is right-aligned and easy to miss; it's actually the
  most consequential affordance on the row when present.
- **`Quarantine.tsx:96`** — Segmented tab control distinguishes active
  tab by background color only. In dark mode the contrast against
  the surrounding card is borderline.

### Low

- **`Codex.tsx:288`** — People / Works / Organizations / Places each
  render as separate `<section>` blocks with no visual grouping. The
  type taxonomy is invisible at a glance.
- **`Page.tsx:296`** — Right-rail cards all use the same card class;
  no visual cue that Mentions and Topics are tightly related.

---

## 8. Microcopy & terminology

This is the second-most-impactful cleanup. We have multiple names for
the same concepts:

| Concept                          | Names in use                                   | Files                                     |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| "Make this sender disappear"     | Block, Mark spam, Quarantine, Hidden           | `Email.tsx`, `Spam.tsx`, `Quarantine.tsx` |
| "This sender is fine"            | Trust, Whitelist                               | `Email.tsx`, `Spam.tsx`                   |
| "Page out of main feed"          | Quarantined, Hidden, Marked spam               | `Home.tsx`, `Quarantine.tsx`, `Hidden.tsx`|
| "Remove from your inbox"         | Remove, Delete, Discard                        | `Email.tsx`                               |

Recommendation — converge on this vocabulary:

- **Block** = sender's mail is dropped at ingest (hard).
- **Mute** (currently "Mark spam") = sender's mail is filed but
  hidden from the main feed (soft).
- **Trust** = sender bypasses the spam classifier (currently
  "Whitelist" + "Trust").
- **Quarantine** = the auto-state when reputation drops; the user
  rescues to clear.
- **Remove** = local-only delete from the user's inbox (keeps
  source).
- **Delete on source** = upstream IMAP/Gmail delete.

Then audit every button, tooltip, and confirmation copy in one PR.

### Specific microcopy issues

- **`Email.tsx:614,616,622`** — Three different phrasings for the same
  Mark spam toggle.
- **`Email.tsx:324,335`** — Confirmation strings include bullet
  points and line breaks that don't render in `confirm()`.

---

## 9. Keyboard & accessibility

### High

- **`Shell.tsx:232`** (already noted) — Missing `aria-current` on
  active NavLinks.

### Medium

- **`Shell.tsx:84`** — `/` is bound globally to "navigate to search,"
  but the user expectation is "focus the on-page search input." On
  `/search` itself, `/` should focus the existing input rather than
  no-op or re-navigate.
- **`Shell.tsx:227`** — Top-level nav buttons have `title` but no
  `aria-label`. Title attributes are tooltip-only and not announced
  consistently by screen readers.
- **No `?` shortcut help modal.** Hotkeys are bound in
  `Shell.tsx:75–113` but never shown to the user. The plan in
  `.devlogs/05-ux-spec.md` calls for one — it never shipped.
- **`CommandPalette.tsx:120`** — Pages list hard-caps at 50 with no
  "+N more" indicator. For users with 200+ pages, half the corpus is
  invisible from the palette.

### Low

- **`DraftReply.tsx:197`** — Save / Send icon-only on narrow widths
  with no `aria-label`.

---

## 10. State persistence & flow

### Medium

- **`Codex.tsx:114`** — Tab + scroll position desync (already noted).
- **`Search.tsx:74`** — `includeLibrary` toggle persists via
  `localStorage`. Private-browsing falls back silently to `false`
  every reload — confusing for users who turned it on.

### Low

- **`Search.tsx:248`** — "Save search" uses `window.prompt()` for the
  name. It's modal, breaks the page flow, and styles inconsistent
  with the rest of the app.

---

## 11. Mobile

### Medium

- **`Email.tsx:524`** — Toolbar wraps to 3+ rows on phones (already
  noted).
- **`Email.tsx:360`**, **`Page.tsx:266`** — Two-column grids stay
  single-column below `lg:` (1024px), so tablets (768–1024px) miss
  the right-rail value.

### Low

- **`Search.tsx:178`** — Search filter selects are `text-xs`; below
  recommended 32px tap target.
- **`Shell.tsx:439`** — Pinned-folder strip lacks scroll affordance.

---

## 12. Specific routes briefly

- **`Home.tsx`** — Edition layout reads well; biggest issue is the
  loading state. CTA copy in the empty case is reasonable but doesn't
  hint at "your ingest queue is processing — check back in 5 min,"
  which is the actual reality for new users.
- **`Inbox.tsx`** — Redirects to `/settings/ingest` (`App.tsx:108`).
  Should probably be removed or reused for a real triage view rather
  than redirect; right now it confuses muscle memory.
- **`Senders.tsx`** — Comment in the file references a previous bug
  with conditionally-called hooks (`Sender.tsx:94`); current
  implementation looks correct but the file is dense and would
  benefit from extracting a `<SenderHeader>` and `<SenderStats>`.
- **`Quarantine.tsx`** — Rescue button (line ~51) has no
  confirmation and no undo. Rescue is constructive but the action
  flips reputation counters; should at least surface a "rescued — undo
  in 5s" toast.
- **`Watches.tsx`** / **`Recipes.tsx`** — Newer surfaces; their
  empty states are bare and don't link to the templates gallery.

---

## Recommendations, prioritized

1. **Standardise destructive-action UX.** Replace every
   `window.confirm` and `window.prompt` with a single
   `<ConfirmModal>` (typed danger button + undo toast). Estimate:
   a day. Affects: ~15 callsites.
2. **Fix `aria-current` on NavLinks.** Five-line change in
   `Shell.tsx`; ships accessibility for keyboard + screen-reader
   users at zero cost.
3. **Compress the Email toolbar.** Group sender controls under a
   "Sender ▾" menu (Mark spam / Block / Trust as a single trio); keep
   Reply, Remove, More at the top level. Makes the toolbar fit on a
   phone in one row.
4. **Add skeletons** to Home, Page, Email, Search, Quarantine. Pure
   visual win; no API changes.
5. **Vocabulary PR.** Block / Mute / Trust / Quarantine / Remove /
   Delete-on-source — pick five, rename, audit copy. Small diff,
   massive comprehension win.
6. **Lower the two-column breakpoint** from `lg:` to `md:` on Email
   and Page; reclaim the 768–1024px tablet range.
7. **Ship the `?` keyboard help modal.** All the bindings are
   already in `Shell.tsx:75`; just render them.
8. **Recipe wizard:** filter actions by trigger compatibility.
9. **Centralise error humanisation** in the API client (one wrapper
   in `apps/web/src/lib/api.ts`); call sites still get raw errors as
   a fallback.
10. **Email toolbar `Send` confirmation** in `DraftReply.tsx:150`.
    Even a one-second "Sending in 3… (cancel)" Gmail-style undo strip
    would do.

---

## What works well

- **Two-column layout pattern** on Email and Page reads cleanly; the
  `minmax(0, …fr)` precaution against unbreakable strings is the
  right call.
- **`LinksCard` extraction** — single-source-of-truth for the
  hostname-grouped, tracking-bucketed list. Article and Email now
  share it.
- **`CountedSection`** is doing real work: cards over a threshold
  collapse into `<details>` automatically. Once it's adopted on the
  remaining big cards (Mentions, Sources cited) the right rail will
  feel a lot lighter.
- **Sender-trust toolbar** post-recent-fix actually does what users
  expect — releases brand-wide existing pages from quarantine
  immediately, including subdomain siblings.
- **The command palette** is a clear strength; `cmdk` integration is
  fast and the find-by-page-title flow works well. The 50-item cap is
  the only thing standing between it and being a daily-driver feature.

---

## Out of scope for this review

- Visual design (typography, color palette, spacing scale). The
  current Tailwind preset reads well; no obvious wins.
- Animation / transitions. Currently minimal; that's fine.
- Internationalisation. Not in scope until the rest of the app
  settles.
- Performance profiling under load. Worth a follow-up devlog after
  the items above land.

---

*Review by Claude. Generated against the snapshot at
`adb3f6b → 3622108`. Re-run after the prioritised fixes ship to
re-baseline.*
