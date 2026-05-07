# White-label

**Status:** Design — not yet built.
Future-looking; written so a future implementation pass can start
without re-deriving the design.

This doc proposes turning Rose's hardcoded "Rose" identity into a
configurable **Deployment Identity** so an operator can rebrand the
whole instance, and lays the architectural groundwork for a future
**multi-tenant** mode where one Rose deployment can serve many
brand-isolated organisations from a single host.

---

## 1. Why

Rose ships with a strong editorial identity — the rose-pink palette,
the serif headline grid, "Today's Edition", "Logistics desk",
"Discounts desk", `Rose-Recipes/1.0` user-agents on outbound
webhooks. That identity is load-bearing for the metaphor; it's also
hard-coded everywhere.

Three concrete pressures push us toward white-labeling:

| Pressure | Today | Without white-label |
| --- | --- | --- |
| A self-hoster wants to call it "Crimson" with their own logo and color | Forks the repo, edits ~50 files | Loses every upstream change unless they keep merging |
| An MSP / consultancy hosts Rose for several end-clients | Either runs N independent stacks or asks every client to accept "Rose" | Pays Mongo / Redis / Ollama overhead N× or has a brand-mismatch UX |
| A power user runs Rose for a small org and wants the UI to feel like an internal tool | Same as above | Stuck with "Rose" |

The natural fix is two tiers, sharing a data shape:

- **Tier 1 — Deployment Identity (V1):** one operator, one instance,
  fully rebrandable. Schema is one document.
- **Tier 2 — Multi-tenant (V2):** the same brand schema, scoped per
  tenant, resolved by hostname. Independent of V1's ship date but
  intentionally a strict superset of its data model.

This doc commits to V1 and sketches V2 deeply enough that V1 doesn't
back us into a corner.

---

## 2. What's "Rose-branded" today

A quick audit — surface points that need to become configurable.

### 2.1 Visible chrome
1. **App name** — `<title>Rose — Email Wiki</title>`,
   `apple-mobile-web-app-title`, the Shell brand link
   (`<img src="/rose.svg" /> Rose`), Login / Register page headings.
2. **Logo** — `apps/web/public/rose.svg`, used at `h-7 w-7` in the
   Shell and `h-9 w-9` on auth screens.
3. **Favicon** — derived from `rose.svg` today.
4. **Color palette** — Tailwind's `rose-{50,100,…,950}` classes are
   used in **44 files** across the SPA. This is the single biggest
   refactor.
5. **Typography** — `font-serif` for headlines (browser default
   serif), system sans for body. No webfont link yet.
6. **Newspaper metaphors in copy** — "File a story", "Today's
   Edition", "Logistics desk" (Shipments page header), "Discounts
   desk" (Promo Codes header), "Sources cited", "Now processing".
   These are part of the product, but an operator may want to
   neutralise them ("Inbox", "Tracking", "Coupons").

### 2.2 Outbound identity
1. **Push notifications** — `push-sw.js` falls back to `title: 'Rose'`.
2. **Webhook delivery** — `User-Agent: Rose-Webhooks/1.0`,
   `X-Rose-Event`, `X-Rose-Delivery`, `X-Rose-Signature` headers.
3. **Recipe webhook delivery** — `User-Agent: Rose-Recipes/1.0`.
4. **Shipment-tracking adapter** — `User-Agent: Rose-Shipments/1.0`.
5. **Digest email** — `From:`, `Subject:` prefix.
6. **Outbound replies** — `From:` derived from the user's connected
   account, but the signature/footer is bare today.
7. **Public share-link pages** (`/share/<slug>`) — render the SPA
   shell so the brand bleeds through.

### 2.3 Operator-only / static
1. `package.json` package names (`@rose/api`, `@rose/web`, …) — these
   are workspace identifiers, not user-visible. **Out of scope.** We
   don't rename them; the project name and the deployed brand are
   distinct concerns.
2. Mongo collection names, BullMQ queue names (`rose.recipes`,
   `rose.imap-sync`). **Out of scope** for the same reason.
3. Docker image tags / CI artifacts. Operator's repo problem.

### 2.4 Conspicuously not changing
- **`SenderBrand` documents** — those are *external* brands (Stripe,
  Linear, Amazon) that Rose learns about. The deployment brand is a
  *separate* concept; we deliberately do not call it `Brand` to
  avoid the collision.
- **Sender domain detection** — the `senderDomainTag` helper that
  produces brand keys for incoming mail is unaffected.
- **Per-user provider settings** — keep working as-is. Tier 2 will
  layer per-tenant defaults, not replace them.

---

## 3. Data model

### 3.1 V1: a singleton `Deployment` document

```ts
// packages/db/src/models/Deployment.ts
type Deployment = {
  /** Always 'default' in V1. Reserved for V2's tenantId migration. */
  key: 'default';

  identity: {
    name: string;                // "Rose" | "Crimson" | "Acme Mail"
    shortName?: string;          // "R" — favicon fallback initials
    tagline?: string;            // shown on auth screens + about
  };

  visuals: {
    logoUrl?: string;            // https URL or data: URI; svg/png/webp
    logoDarkUrl?: string;        // optional dark-mode variant
    faviconUrl?: string;         // optional separate favicon
    /** Single hue (any CSS color); we generate the 50..950 ramp on
     *  the server so contrast is preserved. */
    primaryHue: string;          // "#E11D48" (rose-600 default)
    /** Optional secondary accent for emphasis cards. */
    accent?: string;
  };

  fonts?: {
    /** Inline `<link href=…>` or `@font-face` snippet the operator
     *  trusts. Rendered into <head>; null skips webfont loading. */
    headLink?: string;
    serif?: string;              // CSS font-family for headlines
    sans?: string;               // body font-family
  };

  copy?: {
    /** Replace newspaper-vocabulary labels with neutral ones. */
    desks?: {
      shipments?: string;        // default "Logistics desk"
      promoCodes?: string;       // default "Discounts desk"
      home?: string;             // default "Today's Edition"
    };
    metaphors?: 'newspaper' | 'archive' | 'inbox' | 'custom';
  };

  outbound: {
    fromAddress?: string;        // "noreply@brand.example"
    replyTo?: string;
    /** Default push notification title when a recipe / rule didn't
     *  override it. Defaults to identity.name. */
    pushTitle?: string;
    /** Used as the prefix in User-Agent strings: e.g. "Crimson" →
     *  "Crimson-Recipes/1.0". Defaults to identity.name. */
    userAgentPrefix?: string;
    /** Header prefix for webhook delivery: "X-Crimson-Event"… */
    headerPrefix?: string;       // default identity.name (kebab-cased)
  };

  web: {
    /** Canonical hostname Rose advertises in share links and emails.
     *  When unset, the request's Host header is used. */
    canonicalHost?: string;
    /** Suffix appended to share-link <title> tags. */
    publicTitleSuffix?: string;
  };

  legal?: {
    footerLine?: string;         // "© 2026 Acme Corp"
    privacyUrl?: string;
    termsUrl?: string;
    contactEmail?: string;
  };

  /** Increments on every save; the SPA caches brand JSON keyed
   *  on this so cache-busting is deterministic. */
  version: number;
  updatedAt: Date;
  updatedBy: ObjectId;           // User who last saved
};
```

Seeding is trivial: a migration inserts `{ key: 'default', identity: { name: 'Rose' }, visuals: { primaryHue: '#E11D48' }, version: 1 }`. Existing UI keeps working because every field has a sensible default.

### 3.2 V2: same schema, per `Tenant`

V2 introduces a `Tenant` collection. Each tenant document **inlines
the same `identity` / `visuals` / `copy` / `outbound` / `web`
blocks** — no schema divergence, no per-version branching code.
V2-only additions:

```ts
type Tenant = {
  _id: ObjectId;
  slug: string;                  // "acme" — used in admin URLs
  hostnames: string[];           // ["mail.acme.example", "rose.acme.com"]
  status: 'active' | 'suspended';
  /** Same shape as Deployment fields above. */
  identity: …;
  visuals: …;
  copy?: …;
  outbound?: …;
  web?: …;
  legal?: …;
  /** Per-tenant LLM provider defaults; users can still override. */
  providers?: {
    generation?: { providerId: 'ollama' | 'anthropic' | 'openai'; model: string };
    embedding?:  { providerId: 'ollama' | 'openai';              model: string };
  };
  createdAt: Date;
  updatedAt: Date;
};
```

Every tenant-scoped collection (`User`, `Email`, `Page`, `Source`, …)
gains a `tenantId: ObjectId` indexed field. Helper functions
(`userIdOf(req)` →  `userScopeOf(req)` returning `{ userId, tenantId }`)
flow the scope into every query.

V1's `Deployment` is essentially a singleton tenant — V2 ships by
turning it into row 1 of `Tenant` and rewriting reads to consult
`req.tenant` instead of the singleton.

---

## 4. Wire surfaces

### 4.1 `GET /api/brand` — public

```ts
// Response shape (intentionally minimal — auth screens use this)
type BrandResponse = {
  identity: { name: string; shortName?: string; tagline?: string };
  visuals: {
    logoUrl?: string;
    logoDarkUrl?: string;
    faviconUrl?: string;
    /** Pre-computed 50..950 ramp from primaryHue, ready to drop
     *  into CSS variables. */
    palette: Record<'50' | '100' | '200' | '300' | '400' | '500' |
                    '600' | '700' | '800' | '900' | '950', string>;
    accent?: string;
  };
  fonts?: { headLink?: string; serif?: string; sans?: string };
  copy?: Deployment['copy'];
  legal?: Deployment['legal'];
  version: number;
};
```

- **Unauthenticated** so the login page can render the right brand
  before the user has any session.
- **Cacheable**: `Cache-Control: public, max-age=300` plus an ETag on
  `version`. The SPA fetches once per session and refreshes when the
  version bumps.
- **Not user-scoped**: every visitor sees the same brand. Tier 2:
  resolved per `Host` header, but still anonymous.

### 4.2 `GET /api/brand/manifest` — operator

The same data plus operator-only fields (raw `primaryHue` rather
than the pre-computed ramp, the full `outbound` / `web` blocks)
so the brand editor can round-trip without losing precision.

### 4.3 `PATCH /api/brand` — operator

Validated by Zod. Logo + favicon uploads come in as separate
`POST /api/brand/upload` multipart endpoints (max 256 KB, SVG / PNG /
WEBP only, sniffed by magic bytes). The endpoint stores the asset as
a data URI on the document so we don't introduce a blob store
dependency in V1.

Auth: bound to a new `User.role === 'operator'` flag. Bootstrap rule:
the first user to register on a fresh deployment becomes the operator;
subsequent registrants are regular users.

### 4.4 `POST /api/brand/preview` — operator

Returns the computed brand response **without saving**. The brand
editor uses this to live-preview palette / copy changes before
committing.

---

## 5. The Tailwind problem

44 files use literal `rose-*` classes. Tailwind tree-shakes by string
match, so simply renaming to `brand-*` won't work — Tailwind needs
to see the literal classes in the source.

**Adopted approach: CSS variables + Tailwind theme indirection.**

```js
// tailwind.config.js
theme: {
  extend: {
    colors: {
      brand: {
        50:  'rgb(var(--brand-50)  / <alpha-value>)',
        100: 'rgb(var(--brand-100) / <alpha-value>)',
        // …
        950: 'rgb(var(--brand-950) / <alpha-value>)',
      },
    },
  },
}
```

The SPA writes the 50..950 RGB triples into CSS variables on
`<html>` at boot, sourced from `/api/brand`. All `bg-rose-500` →
`bg-brand-500`. The default values match today's rose palette, so
the visual delta after the refactor is zero unless the operator
saves a new brand.

**Codemod plan** (one-shot, reviewed):
- `find apps/web/src -name '*.tsx' -o -name '*.ts'` →
  `sed -i 's/rose-\([0-9]\+\)/brand-\1/g'`
- `git diff` review — flagging any case where `rose-*` was a tag /
  data string and not a class (none expected, but the review exists
  for safety).
- Land in one PR so we never have a mixed `rose-*`/`brand-*`
  codebase.

**Palette generation**: server-side, derived from `primaryHue`. We
already use `culori` indirectly via Tailwind; adding `chroma-js` or a
hand-rolled HSL-shift function gives us a 50..950 ramp at server-render
time. Saving validation rejects hues that produce <4.5:1 contrast
against either light or dark backgrounds at the 700 / 200 stops.

---

## 6. Wiring it up

### 6.1 SPA boot

1. `index.html` ships with no logo and a placeholder
   `<title>Loading…</title>`.
2. The app shell fetches `/api/brand` before the first route renders.
3. Brand response writes:
   - `--brand-50`..`--brand-950` on `<html>`
   - `<title>` to `identity.name`
   - `<link rel="icon" href={faviconUrl ?? identity.shortName ⇒
     generated SVG>}`
   - `<link rel="…">` for the optional webfont (if `fonts.headLink`)
4. Brand JSON lands in a Zustand / React-context store; components
   read `useBrand().identity.name` instead of the literal string.

### 6.2 Server-side rendering on share pages

`/share/<slug>` is server-rendered (today: a stripped-down HTML
page produced by the API). It needs the brand for `<title>`,
favicon, the visible footer. Solution: server reads the singleton
`Deployment` doc once, embeds the brand JSON inline so the share
page renders without an extra fetch.

### 6.3 Outbound paths

A small `branding.ts` module on each app package exposes:

```ts
export async function brand(req?: Request): Promise<BrandSnapshot> {
  // V1: cached singleton lookup.
  // V2: req.tenant.brand.
}
```

Threaded into:

- `webhookDeliver.ts` — `User-Agent: ${brand.outbound.userAgentPrefix
  ?? brand.identity.name}-Webhooks/1.0`, `X-${headerPrefix}-…`.
- `recipes.ts` (`runWebhookPost`, `runNotifyPush`) — same.
- `shipments` adapters — same.
- `pushNotify.ts` — default title.
- `digestEmail.ts` — `From`, `Subject` prefix.
- `share.ts` — public page chrome.
- `auth.ts` — confirmation/reset email templates.

The worker reads brand on boot and re-fetches on a 5-minute interval;
brand changes don't need to be instant for outbound. The API reads
on every request via a 30s in-memory cache keyed on `version`.

### 6.4 Operator UI

New surface: **Settings → Brand** (admin-only).

- Identity: name, shortName, tagline (text inputs).
- Visuals: logo upload (drag-drop), favicon upload, primary-hue
  color picker, accent color picker. Live-preview pane on the right
  shows a fake Home / share-page / push notification with the
  pending palette.
- Fonts: optional CSS link, optional `font-family` overrides.
- Copy overrides: per-desk labels with placeholders for the
  defaults.
- Outbound: from-address, reply-to, push title, user-agent prefix,
  header prefix. **Each comes with a docs banner** explaining the
  DNS / DKIM / SPF implications of changing the from-address.
- Legal: footer line, privacy URL, terms URL, contact email.
- Reset to defaults button.

The editor is plain vanilla forms — no fancy theme builder. Power
users edit the JSON directly via `PATCH /api/brand`; the GUI is the
common-case shortcut.

---

## 7. Flows

### 7.1 V1 happy path: "Acme rebrands their self-host"

```
operator (admin) → /settings/brand
  uploads acme-logo.svg (12 KB)
  picks primaryHue = #4F46E5 (indigo-600)
  copy.desks.shipments = "Tracking"
  outbound.fromAddress = "noreply@acme.example"

PATCH /api/brand → server validates, generates 50..950 ramp,
                   bumps version to 7, saves.

SPA reads /api/brand on next page load (or on the
ETag invalidation that the editor pings) → repaints CSS vars,
swaps logo, retitles tab.

Worker sees version bump on its 5-min poll → outbound webhooks
now use User-Agent: Acme-Webhooks/1.0.

Push notifications now show "Acme" instead of "Rose".

Existing share links: render with the new brand the next time
they're loaded.
```

### 7.2 V2 happy path: "Acme onboards Beta-Corp as a sub-tenant"

```
super-operator → /settings/tenants → Add tenant
  slug = "beta", hostname = "mail.beta-corp.example"
  fills brand fields exactly like V1.

DNS: super-operator points mail.beta-corp.example at the same
load balancer; TLS cert covers the new SAN.

End user visits mail.beta-corp.example/login →
hostname middleware → req.tenant = {slug: 'beta', brand: {...}}
                    → /api/brand serves Beta-Corp's brand
                    → SPA renders Beta-Corp's identity from before
                      the user has logged in.

User registers → User row written with tenantId = beta._id.
Every Email / Page / Source the user creates carries that tenantId.
Cross-tenant queries are impossible by construction.
```

### 7.3 Edge case: a user-supplied logo URL is malicious

- Upload path runs magic-byte sniffing to confirm the file is
  actually SVG/PNG/WEBP. SVG is parsed and stripped of `<script>`
  tags before storage (DOMPurify with `RETURN_DOM_FRAGMENT`).
- URL path: only `https:` schemes accepted; the URL is fetched
  through `safeFetch` (existing SSRF guard), the response sniffed
  the same way, and stored as a data URI. We **do not hot-link** —
  storing as data URI eliminates beacon attacks and makes the brand
  document self-contained.
- Size cap: 256 KB. Larger logos are rejected at upload time.

### 7.4 Edge case: from-address change breaks SPF on outbound digest

- The brand editor surfaces an inline diff: "Outbound digest will be
  sent from `noreply@acme.example`. Make sure this domain has SPF /
  DKIM aligned to your mail provider, or recipients may flag your
  digests as spam."
- Saving doesn't *block* on DNS validation — it's the operator's
  call. We add a `POST /api/brand/check-dns` helper (returns
  `{ spf: 'pass'|'fail', dkim: 'unknown' }`) that the editor
  surfaces as a non-blocking warning.

---

## 8. Migration

V1 is a clean install plus an in-place migration:

1. **Schema migration** (`migrations/2026xx_white_label.ts`):
   - Create the `deployments` collection.
   - Insert a single row with the current Rose defaults.
   - No tenant scoping — V2 will handle that separately.
2. **Codemod**: rename every `rose-{n}` Tailwind class to `brand-{n}`
   in `apps/web/src`. Add the `brand` color extension to
   `tailwind.config.js`. Keep `rose` as an alias for one release
   cycle so any out-of-tree forks don't break instantly.
3. **Boot wiring**: SPA fetches `/api/brand` before render; default
   asset URL `/rose.svg` still works since `Deployment.visuals.logoUrl`
   defaults to it.
4. **Outbound thread-through**: replace literal `'Rose'` strings with
   `brand.identity.name`. Headers like `X-Rose-Signature` use
   `X-${brand.outbound.headerPrefix}-Signature` with `'Rose'` as the
   default so existing webhook consumers keep working until the
   operator opts to rebrand.
5. **Operator role**: add `User.role: 'operator' | 'member'`.
   Migration: the existing `ADMIN_EMAIL` env-derived admin gets
   `role: 'operator'`; everyone else gets `member`.

V2 ships separately and starts with a destructive migration:

- Create `tenants` collection seeded from the singleton `Deployment`.
- Add `tenantId` field to every user-scoped collection. Migration
  walks every row and stamps the singleton tenant's id.
- Drop the singleton; resolve brand via `req.tenant` going forward.
- Add hostname middleware. Login forms gain a tenant-slug fallback
  for the case where the operator hasn't pointed a hostname yet.

V2 is intentionally **not** a strict-superset bolt-on of V1; the
hostname-routing layer touches enough of the request pipeline that
it deserves its own design doc when the time comes. V1's job is to
make sure the **data shape** is forward-compatible, which the schema
above does.

---

## 9. Risks

1. **Tailwind class rename touches every file.** Forty-four `.tsx`
   files. The codemod is mechanical, but a careful PR review pass is
   non-negotiable so we don't break a string that happens to match
   the regex.
2. **OAuth consent screens stay branded by Google.** The "Rose by
   Acme wants permission to access your Gmail" screen comes from the
   Google Cloud Console's OAuth client configuration. White-label
   doesn't reach that — the operator must rebrand at the Google
   Console level. **The Brand editor must call this out**
   prominently.
3. **Push notifications already shipped.** End users have
   service-worker registrations expecting `title: 'Rose'`. The
   service worker reads the title from the payload, which the worker
   sets from brand. Existing registrations keep working; the new
   title shows up on the next push.
4. **Email reply threading.** Outbound replies use the user's
   connected mailbox `From:`. The brand `outbound.fromAddress` is
   only for *system* mail (digests, password resets). We must not
   accidentally rewrite the user's reply-from — check `sendOutbound.ts`.
5. **Light-vs-dark contrast on operator-picked hue.** A pretty hue
   on white can be unreadable on `bg-ink-950`. Server-side palette
   generation enforces a contrast threshold at the 700 / 200 stops
   and refuses to save an unreadable palette. The error suggests a
   nearby valid hue.
6. **Cache invalidation across the worker fleet.** Brand changes are
   eventually-consistent for outbound (5-min poll) but *immediately*
   visible in the SPA (ETag-aware fetch). Mismatch is fine: a
   webhook delivered 30 seconds after a brand change might still
   carry the old `User-Agent` — that's a feature, not a bug, since
   downstream webhook consumers might key on the prefix.

---

## 10. Open questions

- **Webfont licensing.** If we self-host fonts, the operator becomes
  responsible for their license. V1 punts: operator supplies a
  `<link>` and CSS family; we don't bundle anything.
- **Per-tenant encryption key (V2).** Tier 2 may want a tenant-scoped
  data-at-rest key so a compromise of one tenant's secrets can't
  decrypt another's. Open: scope vs implementation cost.
- **Newspaper-metaphor vs neutral copy toggle.** Should `metaphors:
  'newspaper' | 'archive' | 'inbox' | 'custom'` be a single dropdown
  that swaps a curated bundle of strings, or should every desk label
  be individually overridable? V1 ships individual overrides;
  bundles are a polish layer if needed.
- **Brand-as-code vs brand-in-DB.** Some operators will want their
  brand in version control (Git → JSON → bootstrapped on deploy).
  Two paths: the Brand editor exports JSON, and a one-shot
  `bootstrap-brand.ts` script reads `brand.json` at deploy time.
  V1 ships the editor; the bootstrap script is a small follow-up.

---

## 11. Phases

1. **Prep** — codemod `rose-*` → `brand-*`, ship Tailwind CSS-var
   theme, default values match today exactly. **Zero visible change.**
2. **`Deployment` model + `/api/brand`** — public read endpoint;
   defaults seeded; SPA fetches and applies on boot. Brand
   JSON in the editor is read-only here.
3. **Operator role + brand editor** — `User.role`, admin-gated
   `PATCH /api/brand`, the GUI. Logo / favicon upload endpoints. End
   of this phase: a self-hoster can fully rebrand.
4. **Outbound thread-through** — webhooks, push, digest emails,
   share-page chrome. Default-preserving so existing integrations
   keep working.
5. **Brand-as-code bootstrap script** — small script that reads
   `brand.json` and idempotently upserts into the `Deployment` doc.
6. **(Separate doc, separate ship) V2 multi-tenant** — `Tenant`
   model, hostname middleware, scope migration. New design doc when
   we get there.

Phases 1–5 are V1. Each phase is independently shippable and adds
incremental value without breaking the previous phase.
