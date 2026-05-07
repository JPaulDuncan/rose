# IFTTT-style Recipes

**Status:** Design — not yet built.
Future-looking; written so a future implementation pass can start
without re-deriving the design.

This doc proposes folding Rose's three existing rule-shaped systems
(per-email `Rule`s, `NotificationRule`s, `WebhookSubscription`s) and
several implicit ones (spam policy, blocked-senders list,
auto-quarantine) into one user-facing automation surface called
**Recipes** — a typed *trigger → conditions → actions* model in the
shape of IFTTT / Zapier.

---

## 1. Why

Rose already has automations. They live in disjoint UIs with
disjoint mental models:

| Today                          | What it actually is                              |
| ------------------------------ | ------------------------------------------------ |
| `Rule` model + `/settings/rules` | "When an email matches X, do Y to it."           |
| `NotificationRule`             | "When a high-priority email arrives, push X."    |
| `WebhookSubscription`          | "When event X happens, POST to URL Y."           |
| `User.spamPolicy.senders[]`    | "Mark every page from sender X as spam."         |
| `spamPolicy.blockedSenders[]`  | "Drop everything from sender X at ingest."       |
| `Sender.autoQuarantine`        | "If sender's net spam-marks ≥ 3, hide their pages." |
| Featured tags                  | "Pin a section for tag X on the home digest."    |
| Saved searches                 | "Re-run query X on demand."                      |

Every one of these is a degenerate *trigger → action* recipe. The
user can't browse them in one place, can't compose them, and adding
a new automation surface (say, "when a deadline is approaching")
means another model + another UI tab.

A unified recipe surface fixes that and unlocks new automations
that don't fit any of the existing categories — recurring time
triggers, cross-event conditions, multi-step actions, recipe
chaining.

---

## 2. Conceptual model

A **Recipe** is:

```
trigger    — one event subscription (the "if this")
conditions — zero or more boolean predicates ANDed (the "AND only when")
actions    — one or more side-effects run in sequence (the "do that")
```

Plus operational metadata: `enabled`, `cooldownSeconds`,
`lastFiredAt`, `fireCount`, `errorCount`, optional `name` and
`description`.

```
[ Trigger fires ] ──► [ Conditions match? ] ──► [ Cooldown expired? ] ──► [ Run actions ]
        │                       │                         │
        └─ records audit row ◄──┴─────────── short-circuits if any fails
```

### 2.1 Triggers

Every state change in Rose that the user might want to react to
becomes a typed event. The recipes worker subscribes to the bus
and fans out to matching recipes.

| Trigger kind            | Fires when …                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `email.ingested`        | A new `Email` row is written, regardless of source.                     |
| `email.matches`         | `email.ingested` + an inline filter (sender / subject / body / header). |
| `page.created`          | A new `Page` is generated.                                              |
| `page.updated`          | An existing `Page` gains a new source email or hand-edit.               |
| `tag.applied`           | A specific tag (or any tag) lands on a page.                            |
| `entity.mentioned`      | A specific named entity (person / work / organization) appears.         |
| `event.extracted`       | A new `CalendarEvent` is created from an email.                         |
| `deadline.approaching`  | A `kind: 'deadline'` event is N days/hours out.                         |
| `digest.published`      | The daily/weekly newsletter is built.                                   |
| `briefing.published`    | The LLM-narrative weekly briefing is built.                             |
| `source.synced`         | An IMAP / Gmail / RSS / Website poll completed.                         |
| `source.error`          | A source's poll failed.                                                 |
| `weather.condition`     | A configured weather threshold is crossed (e.g. precipChance ≥ 70%).    |
| `moon.phase`            | A specified moon phase begins (today is the new/full/quarter moon).    |
| `time.scheduled`        | Cron-style recurring (`0 8 * * MON` etc.).                              |
| `webhook.received`      | An inbound webhook posts to a recipe-specific URL.                      |

### 2.2 Conditions

Inline filters that narrow when a trigger actually fires actions.
Conditions are ANDed; OR is expressed by writing two recipes.

| Condition kind         | Example                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `tag.contains`         | "page is tagged `work`"                                          |
| `tag.not-contains`     | "page is NOT tagged `archive`"                                   |
| `sender.brand`         | "sender's brand is `amctheatres`"                                |
| `sender.domain`        | "sender's domain ends in `.edu`"                                 |
| `body.matches`         | "body matches regex `(invoice|receipt)\b`"                       |
| `subject.matches`      | regex on subject                                                 |
| `priority.is`          | `'high' \| 'normal' \| 'low'`                                    |
| `spam-score.gte`       | `0.5`                                                            |
| `category.is`          | "category is `Personal Finance`"                                 |
| `time.between`         | `08:00` – `18:00`, optional day-of-week mask                     |
| `weather.gte`          | reads cached `/api/weather` response                             |
| `expression`           | A sandboxed JSONata or simple boolean expression over a frozen   |
|                        | event payload. Escape hatch for power users; UI-driven recipes   |
|                        | won't generate these.                                            |

### 2.3 Actions

What the recipe does when it fires. Run sequentially; one failure
records an error in audit but continues to the next action.

| Action kind             | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `notify.push`           | Send a Web Push notification to the user's registered endpoints.   |
| `notify.email`          | Send a self-addressed email (uses outbound delivery infra).        |
| `webhook.post`          | POST a JSON payload to a URL (replaces `WebhookSubscription`).     |
| `tag.add` / `tag.remove`| Mutate the page's tag list.                                        |
| `category.set`          | Override the page's `categoryId` (creates the Category if needed). |
| `page.flag`             | `favorite \| spam \| autoQuarantined \| isNotificationStream`.     |
| `page.archive`          | Hide from default views without deleting.                          |
| `sender.spam`           | Add to `spamPolicy.senders[]` and cascade to existing pages.       |
| `sender.block`          | Add to `spamPolicy.blockedSenders[]` and drop existing emails.     |
| `event.create`          | Insert a `CalendarEvent` (e.g. "remind me 2h before").             |
| `event.dismiss`         | Mark a `CalendarEvent.dismissed = true`.                           |
| `instruction.run`       | Run a stored LLM `Instruction` and (optionally) save the output.   |
| `reply.draft`           | Pre-generate a reply draft via the existing draft-reply pipeline.  |
| `reply.send`            | Actually send a reply (uses the source's outbound config).         |
| `unsubscribe`           | Hit the email's `List-Unsubscribe` URL on the user's behalf.       |
| `recipe.chain`          | Fire another recipe by id, passing the current event as payload.   |
| `instruction.run`       | Already in the table above; intentional repeat for emphasis —      |
|                         | this is the "summon the LLM with my saved prompt" action and is    |
|                         | the most flexible primitive.                                       |

---

## 3. Folding in existing functionality

Each row of section 1's table maps to a default recipe shape:

### 3.1 `Rule` — per-email automation

The current `Rule` model is already a degenerate recipe: condition
list + action list scoped to `email.ingested`. The migration:

- **Schema:** `Rule` is renamed `Recipe`. The existing
  `conditions[]` and `actions[]` arrays carry over; a synthetic
  `trigger: { kind: 'email.ingested' }` is prepended at migration
  time.
- **UI:** `/settings/rules` redirects to `/settings/recipes` with the
  email-trigger filter pre-applied. Users see the same list they're
  used to.
- **`RuleAuditLog`** becomes `RecipeAudit` (same shape, generic over
  recipe id).

### 3.2 `NotificationRule` — push triggers

Each `NotificationRule` is one-to-one with a recipe:

```
{ trigger: { kind: 'email.ingested',
             match: { priority: 'high' } },
  conditions: [...kind-specific conditions from NotificationRule.match],
  actions: [{ kind: 'notify.push' }] }
```

The migration is a one-time sweep that reads every
`NotificationRule` and writes the equivalent `Recipe`. The
`NotificationRule` model can be deleted once the migration verifies.

### 3.3 `WebhookSubscription` — outbound webhooks

Becomes a recipe with `webhook.post` action. The existing
`webhookDeliver` BullMQ queue stays — it's the delivery
implementation; the recipe layer just enqueues into it.

### 3.4 Spam policy + blocked senders

These stay as fast-path config (the worker checks the blocklist
before `email.ingested` even fires) but the UI surfaces each entry
as an *implicit recipe*:

> "Block sender no-reply@example.com" → shows as a recipe row with
> trigger=`email.matches { from: '...'}`, action=`sender.block`,
> with an "imported from spam policy" badge and an "edit / convert
> to full recipe" button.

Two paths for the user:
- **Casual path:** keep using the Spam settings UI; it writes to
  `spamPolicy.*` and the recipes UI shows them as read-only.
- **Power path:** click "convert to recipe" on a spam entry; it
  becomes a normal editable recipe and the policy entry is
  deleted. Going back is a destructive ask, so we'd need an
  explicit confirm.

### 3.5 Auto-quarantine

`Sender.autoQuarantine` (the "≥3 spam-marks" Bayesian threshold) is
trickier — it's a stateful counter, not a recipe. Keep it as-is;
expose a per-sender recipe in the UI that shows *why* a brand is
quarantined ("3 marks, 0 rescues; threshold 3"). Editing the
threshold or decay window stays in the global Spam settings.

### 3.6 Featured tags

A featured tag is a static UI pin, not really a recipe. Leave the
config as-is. Do add a **template**: "When a page tags `<X>`, push
a notification" for users who want active notification on featured
tags.

### 3.7 Saved searches

Add a "Create recipe from this search" button on the search page:
generates a recipe with trigger=`page.created` + conditions
matching the search query + a default action (notify, tag, etc.).

### 3.8 Tag canonicalization & entity extraction

These are pipeline steps, not user-facing automations. Don't fold
them in. They could be expressed as `instruction.run` actions on
`page.created` if a future user wants to override the canonicalize
prompt per-recipe — but that's a follow-up.

---

## 4. What this enables

Concrete recipes a user could build that aren't possible (or are
awkward) today:

1. **Smart routing.** Sender = AMC Theatres → tag with `movies`,
   set category to `Entertainment`.
2. **Selective digest.** New email from Linear with priority high
   → push notification immediately. (Currently requires editing
   `NotificationRule` filters; trivial recipe.)
3. **Auto-archive.** Page hasn't gained a new email in 90 days AND
   has no replies → tag as `archive`. (Requires a
   `time.scheduled` trigger + a JSONata condition over page age.)
4. **Auto-summary post.** When a long-thread page is updated,
   run `instruction:executive-brief` and POST the result to a
   Slack webhook.
5. **Deadline reminders.** Deadline approaching ≤24h → push +
   email reminder. Falls naturally out of `deadline.approaching`
   trigger.
6. **Cross-source dedup alert.** Same article URL appears in 3+
   feeds → mark as breaking, pin to home, push.
7. **Content-aware unsubscribe nudge.** 5+ emails from sender
   tagged `promotional` AND none replied to → suggest unsubscribe
   (or auto-execute if user opts in).
8. **Family monitor.** Email mentions tracked entity `Dad` → push
   high-priority + tag `family`.
9. **Weather-aware briefing.** Precipitation chance tomorrow ≥70%
   → run `instruction:tomorrow-briefing` and email it tonight.
10. **Moon-cycle journaling.** Full moon → run
    `instruction:journal-prompt` and email me a reflection prompt.
11. **Briefing chain.** When the weekly briefing is published,
    fire `instruction:summarize-for-twitter` and post via webhook.

---

## 5. Architecture

### 5.1 Event bus

Today, state changes inside Rose are hard-wired: `imapSync.ts`
writes an `Email` row and queues `generate-page` directly;
`generatePage.ts` writes a `Page` row and queues
`extract-events`. Recipes need a typed event hook, not another
hand-wired branch in every processor.

Two implementation options:

- **Option A — BullMQ event bus:** add a new `recipes` queue. Every
  state-change processor that today does `queue.add(...)` also does
  `recipesQueue.add(eventKind, payload)`. Pros: durable, handles
  worker restarts cleanly. Cons: new queue, extra Redis writes per
  event.
- **Option B — In-process emitter + queue:** processors emit on a
  shared Node `EventEmitter`; a single `recipesDispatcher` listens,
  evaluates triggers in-memory, and only enqueues for *matching*
  recipes' actions. Pros: skips Redis hops for events with no
  matching recipe. Cons: events are lost if the worker dies
  mid-processing.

**Recommendation:** Option A with a thin abstraction. We've been
bitten before by "events lost on worker restart" patterns; the
Redis cost of one extra write per event is dwarfed by the LLM cost
of generating a page.

### 5.2 Recipe evaluation

A new `recipes` worker:

1. Loads enabled recipes into memory at boot, refreshed on a
   pub/sub channel when any recipe is saved/deleted.
2. Indexes recipes by trigger kind so dispatch is O(matches), not
   O(all recipes).
3. For each event:
   - Look up recipes whose trigger kind matches.
   - Inline-match the trigger filter (e.g. sender = `<x>`).
   - Evaluate conditions in order; bail on first false.
   - Cooldown check: skip if `lastFiredAt + cooldownSeconds > now`
     for this `(recipeId, subjectKey)` pair. SubjectKey is the
     event's natural key (page id, email id, deadline id, etc.).
   - Enqueue an `actions-run` job per recipe (so a failing action
     doesn't block siblings).
4. The actions worker executes actions sequentially, capturing
   per-action result/error to `RecipeAudit`.

### 5.3 Time-scheduled triggers

Cron-style triggers run as BullMQ repeatable jobs created when the
recipe is saved. The job ID is `cron:<recipeId>`; on
disable/delete we remove the repeatable. The repeatable's payload
is `{ kind: 'time.scheduled', recipeId }` — the recipes
dispatcher treats it like any other event.

### 5.4 Weather / moon triggers

Don't add a new poller. The existing periodic `/api/weather` and
`/api/moon` calls already populate caches; the recipes dispatcher
runs a small "watch" sweep on a 5-minute interval that reads the
caches and emits events when a watched threshold is crossed.

### 5.5 Inbound webhook trigger

`webhook.received` opens a per-recipe URL like
`/api/webhooks/in/<recipeId>?token=<secret>`. Inbound POST →
emits a `webhook.received` event with the body as payload →
recipe dispatcher routes to the matching recipe. This re-uses the
existing `WebhookSubscription` token machinery.

---

## 6. Data model

```ts
Recipe {
  _id: ObjectId
  userId: ObjectId
  name: string
  description?: string
  enabled: boolean
  trigger: Trigger          // exactly one
  conditions: Condition[]   // ANDed
  actions: Action[]         // sequential
  cooldownSeconds: number   // default 0
  lastFiredAt: Date | null
  fireCount: number
  errorCount: number
  /** Marker for migrated entries that originated as NotificationRule
   *  / WebhookSubscription / spamPolicy. Lets the UI show the
   *  "auto-imported" badge and offer a one-click "edit as full
   *  recipe" path. Null for native recipes. */
  importedFrom: 'notification-rule' | 'webhook' | 'spam-policy' | null
  createdAt + updatedAt
}

RecipeAudit {
  _id: ObjectId
  userId: ObjectId
  recipeId: ObjectId
  firedAt: Date
  /** A natural key for the subject the trigger fired on (email id,
   *  page id, deadline id, …). Used for cooldown bookkeeping. */
  subjectKey: string | null
  /** True if conditions matched and actions ran. False rows record
   *  why the recipe didn't fire (filter mismatch, cooldown, error). */
  fired: boolean
  reason?: string
  results: { actionKind: string; ok: boolean; error?: string }[]
  /** Snapshot of the relevant event payload, capped at ~2 KB so
   *  this collection doesn't balloon. */
  evidence: Record<string, unknown>
}

Trigger | Condition | Action are discriminated unions (Zod-validated
in the shared package and Mongoose-mixed in the DB schema).
```

Indexes:
- `Recipe { userId: 1, enabled: 1, 'trigger.kind': 1 }` — dispatch
  hot path.
- `Recipe { userId: 1, name: 1 }` for the list UI.
- `RecipeAudit { userId: 1, recipeId: 1, firedAt: -1 }` for the
  audit view.
- `RecipeAudit { firedAt: 1 }` with a 30-day TTL.
- Cooldown bookkeeping: a per-`(recipeId, subjectKey)` row in
  Redis with `EXPIRE = cooldownSeconds` is cheaper than scanning
  audit. Use Redis.

---

## 7. UI

### 7.1 List

`/settings/recipes` (or `/recipes` if we want it as a top-level
nav item — likely yes once it absorbs the rules tab):

- Table grouped by trigger kind, with a small badge for the
  trigger ("📧 Email", "📅 Deadline", "⏰ 8 AM Mon", …).
- Each row: name, fires-this-week sparkline, last-fired-ago,
  enabled toggle, edit / duplicate / delete.
- "New recipe" button → wizard.
- A search box at the top.
- Filter chips for `imported-from` so the user can find migrated
  rules.

### 7.2 Wizard

Three-step:

1. **Trigger** — choose from a card grid grouped by category
   (Email, Page, Calendar, Time, Source, Weather/Moon). Each card
   shows the configurable filter inline.
2. **Conditions** — optional. Stacked dropdowns with one
   "Add condition" button. Show the running predicate as a
   plain-English summary above the editor: "When a new email
   arrives AND sender's domain ends in `.edu` AND time is between
   8 AM and 6 PM".
3. **Actions** — drag-reorderable list, one "Add action" button.

Final step: name + cooldown + enabled toggle. Save creates the
recipe and shows the resulting plain-English description for
confirmation.

### 7.3 Templates

A built-in templates library — pre-baked recipes the user can
clone. Examples:

- "High-priority email → push notification"
- "Deadline ≤24h → push + email reminder"
- "Receipts → tag `Personal Finance`"
- "8 AM Monday → run my weekly summary instruction → email it"

Templates ship as JSON in the seed package; each is a
`Recipe`-shaped row with `_id` redacted that the UI clones into
the user's collection on click.

### 7.4 Audit panel

Per recipe: a paginated audit table. Columns: fired-at, subject
(linked), fired/skipped, action results. A "test fire" button on
the recipe edit page that picks the most-recent matching event
from history and runs the recipe in dry-run mode.

---

## 8. Security & resource caps

- **Rate limiting per recipe.** Hard-cap fires-per-hour per
  recipe (configurable, default 60); excess records a row in
  audit with `reason: 'rate-limited'` and skips actions. Catches
  runaway loops.
- **Recipe chain depth.** `recipe.chain` actions limited to 3
  levels deep. Prevents accidental infinite loops.
- **Action timeouts.** Each action has a hard timeout
  (notify: 5 s; webhook.post: 15 s; instruction.run: 60 s); a
  timeout records an error in audit and moves to the next action.
- **Sandboxed expressions.** The `expression` condition uses
  JSONata or a tightly-scoped boolean parser — NOT raw JS — so
  user-authored predicates can't leak data or hang the worker.
  Inputs are a frozen, serialized event payload; outputs must be
  boolean.
- **`webhook.post` SSRF guard.** Reuse the existing
  `assertSafeHttpUrl` helper that the safeFetch / Library / Save
  paths use; same allowlist (no private IPs, no metadata
  endpoints, no DNS rebind).
- **Outbound rate.** Per-user webhook calls share the existing
  `webhookDeliver` queue with its own concurrency cap, so a
  pathological recipe can't fire more outbound POSTs than the
  queue allows.

---

## 9. Phasing

A reasonable build order. Each phase is independently shippable.

### Phase 1 — Core
- `Recipe` schema + Zod definitions for triggers / conditions /
  actions (a small set: `email.ingested`, `tag.applied`,
  `time.scheduled`; conditions: `tag.contains`, `sender.brand`,
  `priority.is`; actions: `notify.push`, `tag.add`,
  `category.set`, `webhook.post`).
- `recipes` BullMQ queue + dispatcher worker.
- Hook event emission into `imapSync` / `gmailSync` / `rssSync` /
  `websiteSync` / `generatePage`.
- `/settings/recipes` list + wizard for the supported types.

### Phase 2 — Migrate existing rule-shaped systems
- Boot-time migration: `Rule` → `Recipe` with synthetic
  `email.ingested` trigger.
- `NotificationRule` → `Recipe` with `notify.push` action.
- `WebhookSubscription` → `Recipe` with `webhook.post` action.
- Spam policy entries shown as read-only recipes with a "convert
  to full recipe" path.

### Phase 3 — Time / weather / moon triggers
- Add `time.scheduled` (BullMQ repeatable).
- Add `weather.condition` and `moon.phase` (5-min watcher sweep).

### Phase 4 — Action chaining + LLM actions
- `recipe.chain` action with depth limit.
- `instruction.run` action — promotes Rose's
  user-customizable `Instruction` registry into a first-class
  automation primitive.

### Phase 5 — Templates + audit polish
- Templates library.
- Audit panel with test-fire / dry-run support.
- Sparklines + last-fired-ago on the list.

### Phase 6 (deferred) — Visual flow editor
- React-flow-style canvas. Big lift; punt until usage data
  shows users hitting the limits of the wizard.

---

## 10. Out of scope (for now)

- **Cross-user recipe sharing.** Could ship a "copy recipe URL"
  later, but a privacy review is required first — recipe payloads
  reference internal IDs (instruction ids, sender brandKeys) that
  don't leak well across users.
- **Multi-trigger recipes** ("when X OR Y happens"). Express as
  two recipes for v1; revisit if duplication gets painful.
- **Loops over collections** ("for each email tagged X, do Y").
  Express as a recipe whose trigger fires per-event; a
  scheduled-batch action is a much bigger UX/engineering ask.
- **A/B-able recipes / staged rollouts.** Not a personal-tool need.
- **Recipe versioning.** Useful but not v1 — a single edit history
  in audit is enough.

---

## 11. Open questions

1. **Where does the Recipe trigger payload live in
   `RecipeAudit.evidence`?** Capping at 2 KB means we lose
   information for big email bodies. Probably fine — the audit
   row references the email/page id; full payload available via
   that lookup.
2. **What happens when an action references a deleted resource?**
   (e.g. recipe action `tag.add` referencing a tag the user
   later deletes; recipe action `instruction.run` referencing a
   deleted Instruction.) Soft-fail: action records an error in
   audit, recipe stays enabled, UI shows a "needs attention"
   badge.
3. **Should `entity.mentioned` be pre-computed or evaluated on
   the fly?** If recipes that watch for "Dad" exist, the
   entity-extraction worker can short-circuit and emit per-event
   instead of per-page. But that ties the recipes layer into
   the entity pipeline awkwardly. Defer; v1 evaluates on
   `page.updated` after entities have been extracted.
4. **Anthropic / OpenAI cost cap on `instruction.run` actions.**
   Today the `instruction.run` action could be wired to a recipe
   that fires per email — a user with a verbose mail flow could
   accidentally rack up a $100 day. Need a per-day token budget
   visible in the UI.

---

## 12. Verification

A future implementation pass should sanity-check the design with:

- Migrate the test fixture's `Rule` rows + `NotificationRule`
  rows into `Recipe`s; verify behavior matches.
- A round-trip recipe export / import (ship in tandem with
  `dataIo`).
- A recipe that fires per `email.ingested` with cooldown 1 minute
  + a noisy mail source: confirm the cooldown actually throttles.
- A recipe that uses `webhook.post` to a deliberately-private IP:
  confirm `assertSafeHttpUrl` blocks it.
- A recipe chain three deep that loops back: confirm the depth
  guard kicks in.
- A `time.scheduled` recipe set to fire every minute, then
  disabled: confirm the BullMQ repeatable is removed.
