# Plan 16 — Admin reset

**Status:** Shipped.
Retrospective spec.

---

## Goal

A single user (the operator) gets a Settings → Admin surface that
wipes the corpora — granular checkboxes per category. Used for
greenfield resets ("start over") and for clearing stuck pipelines
during development.

This is operator-mode functionality, not a multi-tenant
administration surface. The single admin email is set in env;
everyone else gets a 403 on the underlying routes and never sees
the Settings tab.

---

## Configuration

Single env var: `ADMIN_EMAIL`. Defaults to
`jpaulduncan@gmail.com`. Compared case-insensitively against
`User.email`. Set to empty string (`ADMIN_EMAIL=`) to disable
the admin surface entirely; the routes 404 in that mode rather
than 403, so a misconfigured deploy doesn't leak the existence of
admin endpoints.

---

## Auth model

`apps/api/src/middleware/admin.ts`:

- `requireAdmin` — full middleware. 401 if no token (defers to
  `requireAuth` which mounts above), 403 if authenticated but the
  user's email doesn't match, 404 if `ADMIN_EMAIL` is empty.
- `isAdminRequest(req)` — predicate variant for routes that don't
  want to short-circuit the response themselves. The
  `/api/admin/me` endpoint uses this so non-admins get a clean
  `{isAdmin: false}` response without 403 spam in logs.

Both resolve email per-request rather than caching; an
`ADMIN_EMAIL` change in env propagates without restart.

---

## API surface

```
GET  /api/admin/me              — { isAdmin: boolean }. Cheap;
                                   the SPA polls on Settings
                                   layout mount to decide whether
                                   to render the Admin tab.
GET  /api/admin/reset/scopes    — Catalog of resettable buckets
                                   for the UI to render checkboxes.
POST /api/admin/reset           — Body: {confirm: 'RESET',
                                   scopes: string[]}. Runs each
                                   scope's deleteMany sequentially
                                   in catalog order. Returns
                                   per-scope counts + per-scope
                                   error info when any failed.
```

Both `/scopes` and `/reset` are gated by `requireAdmin`. The
literal string `RESET` is required in the body — anything else
yields 400.

---

## Scope catalog

24 scopes across 5 groups. The full list is in
`apps/api/src/routes/admin.ts:SCOPES`; the highlights:

### Global knowledge (every user is affected)
- **Daydream notes** — `DaydreamNote` collection.
- **Sender brands** — `SenderBrand` (logos, briefs, addresses).

### Content (every user is affected)
- **Wiki pages + revisions** — `Page` + `PageRevision`.
- **Emails (raw + parsed)** — `Email`.
- **Calendar events** — `CalendarEvent`.
- **Conversations + chat messages** — `Conversation` + `Message`.
- **Library documents** — `LibraryDocument`.
- **Outbound drafts + audit** — `OutboundMessage`.

### Per-user metadata (every user is affected)
- **Per-user sender state** — `Sender` (counters / overrides).
- **Entity registry** — `Entity`.
- **Tag canonicals** — `TagCanonical`.
- **Categories** — `Category`.
- **User filter rules** — `Rule` + `RuleAuditLog`.
- **Tag digests** — `TagDigest`.
- **Bayes profiles** — `BayesProfile`.
- **Read state** — `UserPageState`.
- **Share links** — `ShareLink`.
- **Saved searches + featured tags** — embedded in User docs;
  this scope `User.updateMany` clears `savedSearches[]`,
  `featuredTags[]`, `weatherLocation`.

### Subscriptions / sources (DESTRUCTIVE)
- **Email sources** — `Source` + `LibrarySource`. Encrypted
  credentials go with them; users have to re-link IMAP / Gmail /
  RSS / Slack / Discord / Calendar / Library accounts.
- **Webhook subscriptions** — `WebhookSubscription`.
- **Push notification registrations** — `PushSubscription` +
  `NotificationRule`.
- **API tokens** — `ApiToken`.

### Infrastructure
- **BullMQ job queues** — Redis SCAN over `bull:rose.*`,
  obliterates every Rose-namespaced queue's keys.
- **Redis caches** — Redis SCAN over `webcache:*`, `rl:*`,
  `rose:idle:*`, `rose:dailycap:*`. Forces every cached call to
  round-trip again.

Order matters: catalog order runs revisions before the pages they
reference, messages before conversations, notification rules
before push subscriptions, etc. The endpoint sorts the requested
scope list by catalog order rather than honouring the request's
order.

---

## What stays untouched

- **User accounts.** Even the admin's own row stays. The
  saved-searches scope clears the embedded fields without
  deleting the wrapper document.
- **Instructions** (the LLM prompt registry). `seedSystemInstructionsForUser`
  re-seeds at boot anyway, but a wipe would lose user-cloned
  custom instructions, so it's not a scope.
- **`Provider` config** (Anthropic / OpenAI / Ollama settings on
  User.settings). Resetting these would disable LLM operation
  entirely; not worth the foot-gun.

If the admin genuinely wants any of those gone, MongoDB shell
beats adding a foot-gun to the UI.

---

## Web surface

`apps/web/src/routes/settings/Admin.tsx`:

- Red "Operator-mode reset" header explaining the destructive
  nature.
- Five collapsible groups of checkboxes, one per scope, each with
  the description from the scope catalog.
- "Select all" / "Deselect all" + per-group toggles.
- "Type RESET to confirm" input. The reset button stays
  disabled until the input matches and at least one checkbox is
  ticked.
- Browser confirm dialog as a final guard before the request
  fires.
- Last-result panel showing each scope's outcome (cleared count
  or error message).

`apps/web/src/routes/settings/Layout.tsx` adds an "Admin" tab to
the right of the existing tabs, in red, only when
`/api/admin/me` says the user is admin. Cached via TanStack Query
with a 5-minute stale time.

---

## Privacy / safety posture

- **Server-side gate is load-bearing.** A non-admin user crafting
  the request manually still gets 403; the SPA-side tab hide is
  UI ergonomics, not a security boundary.
- **Confirm string is case-sensitive.** Typing `reset` in
  lowercase fails — small friction, real protection against
  accidental clicks.
- **No undo.** Documented in the UI. The plan doc, this devlog,
  and the inline scope descriptions all repeat this.
- **Logs.** Every successful scope clear logs at `warn` level
  with the scope id and document count, so auditing what the
  admin wiped is grep-able.
- **One admin.** The model assumes a single operator email.
  Multi-admin is out of scope; if needed, expand `ADMIN_EMAIL` to
  a comma-list in a future commit.

---

## Future bits (deferred)

- **Per-user reset.** "Wipe Bob's data only." Not in scope; the
  current model is operator-as-instance-owner.
- **Soft-delete / undo window.** A "trash" collection holding
  deleted rows for 24 hours. Real value but real complexity.
- **Settings-export-then-reset.** Combo flow: download a portable
  archive (the existing `/api/me/export` endpoint covers this)
  before wiping. Nothing prevents the admin from doing this
  manually today.
