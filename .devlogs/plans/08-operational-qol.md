# 08 — Operational + Quality-of-life

A grab-bag of durable improvements that touch many surfaces but each
have a small individual scope: PWA + offline, read-state and favorites,
saved searches / smart folders, attachment storage on object stores,
full export/import, and multi-user workspaces with permissions.

## Goal

These don't change *what* the product does — they make it pleasant
and durable. Pick off one piece at a time once 01–07 have shipped.

## Components

1. [PWA + offline](#pwa--offline)
2. [Read-state, favorites, follow](#read-state-favorites-follow)
3. [Saved searches / smart folders](#saved-searches--smart-folders)
4. [Attachment storage out of Mongo](#attachment-storage-out-of-mongo)
5. [Full export / import](#full-export--import)
6. [Multi-user workspaces](#multi-user-workspaces)

---

## PWA + offline

Make the SPA installable + offline-readable for already-fetched pages.

### Approach

- Add a Vite `vite-plugin-pwa` config: precaches the app shell + most
  recent 50 pages. Service worker uses
  `staleWhileRevalidate` for `/api/pages/*` GETs.
- Add `manifest.json` (already have a `rose.svg` for icons; generate
  PNG sizes 192/512/maskable).
- Background-sync queue for `POST /api/spam/page/:id`,
  `POST /api/senders/:k/refresh`, etc. — actions taken offline that
  should fire on reconnect.

### Scope

PWA for read + queue-mutation, not for full ingestion. The user can
read pages on a plane; they can't draft replies offline.

---

## Read-state, favorites, follow

Three lightweight per-user-per-page bits, plus a "follow tag/sender"
notion (overlapping with plan 04's notification rules).

### Data model

A new `userPageState` collection:

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `pageId` | ObjectId | indexed; `{userId,pageId}` unique compound |
| `read` | Boolean | |
| `readAt` | Date? | |
| `favorited` | Boolean | indexed for "my favorites" view |
| `favoritedAt` | Date? | |

Read-state is opt-in: a setting toggle ("Track which pages I've read")
because it adds clutter for users who want every page to feel new.

### API

```
POST   /api/pages/:id/read         { read: boolean }
POST   /api/pages/:id/favorite     { favorited: boolean }
GET    /api/me/favorites
```

### UI

- A subtle dot next to the page title in lists when unread.
- Star icon on every page header.
- New `/favorites` route (or sidebar pin "★ Favorites").
- Newsletter Home gets a "New since you last visited" ribbon at the
  top, which links into the unread list.

---

## Saved searches / smart folders

A saved search is a named query (with filters) that the user can pin
to the sidebar. The pinned entry shows a live count of matching pages.

### Data model

`User.savedSearches: SavedSearch[]`:
```ts
{
  id: string,            // ulid
  name: string,
  query: string,         // free-text
  filters: {
    tags?: string[],
    senders?: string[],
    dateRange?: { since: string, until: string },
    priority?: ('high' | 'normal' | 'low')[],
    flag?: { isPromotional?: boolean, isNotificationStream?: boolean, ... }
  },
  pinned: boolean,
  notify?: 'never' | 'on-new-match'
}
```

`notify: 'on-new-match'` integrates with plan 04's notifications: a
new page matching the saved search triggers a push.

### API

`/api/saved-searches` CRUD. `/api/saved-searches/:id/results` runs
the query.

### UI

- "Save this search" button in the search results header.
- Sidebar shows pinned searches under a "Smart folders" group with
  unread/match count badges.
- Drag-to-reorder same as nav items.

---

## Attachment storage out of Mongo

Currently every email attachment is held in a Mongo subdocument array.
This is fine until you have a 25MB PDF. Move them out.

### Approach

- Introduce an S3-compatible storage layer behind a small interface
  (`@rose/storage`, new package). Implementations:
  - `local` — disk under `var/uploads/<userId>/<sha>.<ext>`
    (already what plan 05 uses)
  - `s3` — AWS S3 / MinIO via `@aws-sdk/client-s3`
- Keep `Attachment` metadata in Mongo (`filename`, `contentType`,
  `size`, `storageKey`); the bytes live in the storage layer.
- Migrate the existing inline `attachments[].content` blobs to the
  storage layer as part of the rollout.

### API

Attachment downloads stream from the storage layer through the API
(signed URLs in S3 mode for cheap egress; direct stream in local
mode).

### Settings

Operator-level config (env var `STORAGE_BACKEND=local|s3` plus the
S3 creds). Per-user is fine to leave on the platform default.

---

## Full export / import

A user can dump every page + revision + attachment + sender +
conversation as a single archive. Re-import restores into a fresh
account.

### Format

A `.tar.zst` containing:

```
rose-export/
  manifest.json          // version + counts
  pages/<slug>.md        // contentMd with YAML frontmatter for metadata
  pages/<slug>.html      // optional rendered snapshot
  emails/<id>.eml        // raw RFC822 (for anything originally email)
  attachments/<sha>      // raw bytes (deduped by hash)
  senders.json           // address book
  conversations.jsonl    // chat history (plan 01)
  events.jsonl           // calendar events
  rules.json             // automation rules (plan 03)
```

### API

```
POST  /api/export                  start a job; returns jobId
GET   /api/export/:jobId           status + download URL when ready
POST  /api/import                  multipart upload; queued job
```

Both run on a worker queue. Export is read-only and safe to run while
ingestion continues. Import requires a confirmation dialog because it
will replace everything.

---

## Multi-user workspaces

Today every user is an island. A "workspace" lets a small team share a
knowledge base with role-based access.

### Concept

A `Workspace` has members. Every existing collection that's keyed on
`userId` is keyed on `workspaceId` instead, and a `Membership`
collection records roles.

### Roles

- `owner` — billing + delete workspace
- `admin` — invite members, edit any page
- `member` — read everything, edit own pages
- `viewer` — read only

### Data model

### `workspaces`
| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `name` | String | |
| `slug` | String | unique |
| `createdAt` | Date | |

### `memberships`
| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `workspaceId` | ObjectId | indexed; compound unique with userId |
| `role` | enum | owner/admin/member/viewer |
| `invitedBy` | ObjectId? | |
| `joinedAt` | Date | |

### Migration

The single-user mode is essentially a workspace of size 1. The path:

1. Add `workspaceId` to every keyed collection.
2. Migration creates one workspace per existing user, sets membership.
3. Switch all queries from `userId` scoping to `workspaceId` scoping
   plus a permission check based on the requestor's role.

This is the most invasive change in the plan and lands last.

### Sources policy

Sources should remain personal — your IMAP credentials don't belong
to the workspace. So `Source` keeps `userId` *and* gets a
`workspaceId` for the *destination* of the ingested pages.

### UI

- Workspace switcher in the top-left of Shell.
- "Invite member" dialog under Settings.
- Per-page edit lock if `viewer` role.
- Sender / conversation visibility scoped to the workspace.

## Out of scope

- Per-page ACL beyond "everyone in workspace can read". Add later if
  asked — don't speculate on permissions UX.
- SSO. Leave for an enterprise tier.
- Activity feed of workspace edits ("Alice edited X").

## Open questions

1. **Read-state opt-in default**: on or off? Default off — most users
   won't want a pile of "unread" markers on day one.
2. **Saved-search materialisation**: cache match counts or recompute
   per request? Cache with a 60s TTL for sidebar; recompute live in
   the actual search view.
3. **Workspace billing**: out of scope here, but the data model leaves
   room (`Workspace.plan`).

## Verification

- PWA: lighthouse "Installable" passes; offline reload of an already-
  visited page works.
- Read-state: marking many pages read in one batch is single-digit
  millisecond per page.
- Storage migration: an interrupted migration is resumable; partial
  state never loses bytes.
- Export/import round-trip: export → import into a fresh account →
  the wiki looks identical (modulo new ObjectIds).
- Multi-user: a `viewer` cannot mutate any state via API; cross-
  workspace queries return zero rows.
