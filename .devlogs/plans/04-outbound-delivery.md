# 04 — Outbound delivery

How Rose pushes information *out* of the wiki: a self-mailed daily
digest, browser/desktop push notifications, outbound webhooks, and
read-only share links.

## Goal

Today the user has to come to Rose. Outbound delivery flips that: the
edition shows up where the user already is — inbox, browser tab,
external service.

## Components

This plan has four loosely-coupled pieces. Each ships independently:

1. [Daily digest email](#daily-digest-email)
2. [Push notifications](#push-notifications)
3. [Outbound webhooks](#outbound-webhooks)
4. [Share links](#share-links)

---

## Daily digest email

Mail the rendered Top Stories block to the user (or to a colleague) at
a configured time, daily/weekly.

### Data model

`User.settings.digestEmail`:
```ts
{
  enabled: boolean,
  toAddress: string,            // defaults to the user's own
  cadence: 'daily' | 'weekly',
  timeOfDayLocal: string,       // 'HH:MM' in the user's timezone
  weeklyDay?: number,           // 0–6 when weekly
  timezone: string,             // IANA, e.g. 'America/Chicago'
  lastSentAt: Date | null
}
```

### Worker

New repeatable BullMQ job `rose.digest-email` per user, scheduled at
their configured time. Processor:

1. Build the digest payload (reuse `digestRouter`'s internals).
2. Render to HTML using a mjml-style template + a Markdown-to-HTML
   pass for summaries. Include hero image, top 5 stories, datebook,
   most-read.
3. Send via the user's first active outbound transport (SMTP from the
   matching IMAP source, or Gmail API). Fail gracefully if none — set
   `lastSentAt` and surface the error in Settings.

Re-uses the outbound transport from plan 02 — that's why this plan
sits *after* the reply assistant.

### UI

Settings → Newsletter gains "Email this edition" toggle + cadence/time
controls + a "Send now" button.

---

## Push notifications

Browser push for high-priority pages and explicit subscriptions.

### Data model

### `pushSubscriptions`
| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `endpoint` | String | unique; from the WebPush API |
| `keys` | `{ p256dh, auth }` | encrypted at rest |
| `userAgent` | String? | for the "registered devices" list |
| `createdAt` | Date | |

### `notificationRules`
| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `kind` | enum: `priority-high`, `tag`, `sender`, `event-soon` | |
| `match` | Mixed | depends on kind |
| `enabled` | Boolean | |

`event-soon` fires N hours before a calendar event extracted by the
existing event pipeline.

### Worker

`rose.push-notify` queue. Two enqueue points:

- After every page generation, evaluate notification rules and enqueue
  matching pushes.
- A small periodic sweep checks `event-soon` rules every 15 minutes.

WebPush requires VAPID keys. Generate at first use, persist in env, and
expose only the public key to the SPA.

### UI

- A subscribe/unsubscribe button in Settings → Account.
- Per-tag "follow" button — adds a `kind: 'tag'` notificationRule.
- Per-sender "follow" / "mute" buttons on the sender wiki page.

### Out of scope

- iOS push beyond Safari Web Push (not yet stable cross-version).
- Sound / vibration customisation.

---

## Outbound webhooks

Fire HTTP events on key state changes so users can wire Rose into
Zapier, n8n, Discord webhooks, etc.

### Events

| Event | Payload |
| --- | --- |
| `page.created` | `{page, sourceEmailIds, eyebrow}` |
| `page.updated` | `{page, version}` |
| `page.spam.flagged` | `{page, reason}` |
| `event.extracted` | `{event}` |
| `sender.autoQuarantined` | `{sender}` |
| `digest.daily` | full digest payload |

### Data model

### `webhookSubscriptions`
| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `name` | String | display |
| `url` | String | https only |
| `events` | [String] | event names |
| `secret` | String (encrypted) | for HMAC signing |
| `enabled` | Boolean | |
| `lastDeliveredAt`, `lastError` | | |

### Delivery

Reuse BullMQ for retry/backoff. Sign every payload with HMAC-SHA256
in the `X-Rose-Signature` header (`sha256=<hex>`). Include a
`X-Rose-Event` header and a `X-Rose-Delivery` UUID for idempotency on
the receiver side.

Failures retry with exponential backoff up to 6 attempts; after that
mark the subscription `failed` and notify the user via push (chained!).

### UI

Settings → Integrations new tab. CRUD the subscriptions; show recent
deliveries with status; "Send test event".

---

## Share links

Read-only public URLs for a single page or a category.

### Data model

### `shareLinks`
| Field | Type | Notes |
| --- | --- | --- |
| `userId` | ObjectId | indexed |
| `kind` | enum: `page`, `category`, `tag` | |
| `targetId` | ObjectId | for page/category |
| `targetTag` | String? | for tag |
| `slug` | String | random short-id; unique |
| `password` | String? (argon2) | optional |
| `expiresAt` | Date? | |
| `revokedAt` | Date? | |
| `viewCount` | Number | for the dashboard |

### Endpoints

```
POST   /api/share                 create
GET    /api/share                 list
DELETE /api/share/:id             revoke
GET    /share/:slug               public render — no auth header,
                                  optional ?p= password param
```

Public endpoint serves a stripped-down read-only HTML page (server-
rendered minimal template, NOT the SPA, so it works without JS and
without mounting the rest of the app).

### Privacy

- Password is hashed with argon2 (same as user passwords); never
  echoed back.
- Revoked links 410 Gone.
- Viewing a share link doesn't reveal sender addresses or unsanitised
  contentMd; we render through the same Markdown→HTML pass the wiki
  view uses.
- Share links never embed images cross-origin without proxying.

---

## Open questions (across the four pieces)

1. **Webhook event throughput** — high-volume notification streams
   could fan out hundreds of `page.updated` events. Consider a per-
   subscription rate limiter and an option to debounce updates over a
   sliding window.
2. **Push notification permission UX** — browsers are aggressive about
   blocking sites that prompt unprompted. Only ask after the user
   explicitly subscribes to a tag or follows a sender.
3. **Share-link search-engine indexing** — by default add
   `<meta name="robots" content="noindex">`. Allow opt-in per link.

## Verification

- Daily digest: dry-run rendering should never throw if there are no
  pages — produce an empty-state edition gracefully.
- Webhook signing: receiver-side verification example shipped in docs.
- Push subscription: revoking a device endpoint cleans up cleanly,
  doesn't leak entries that 410 forever.
- Share link: a revoked or expired link returns 410, never the page
  body.
