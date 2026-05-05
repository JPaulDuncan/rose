# 11 — Maps (Tier A: events on a map + places on wiki pages)

Two surfaces gain a small read-only map: the Upcoming Events sidebar
+ the Calendar page show pins for events that have a usable
location, and wiki pages with extracted place entities show those
on a small inset in the right rail. No routing, no full-page
interactive map, no email-embedded maps. Everything is opt-in
behind a single Settings → Maps master switch.

## Goal

The user already has the data — calendar events have `location`
strings ("Boise State, Albertsons Stadium"), and wiki pages mention
places — but it lives as plain text. A small map next to that text
turns "where" from a parsing problem into a glance.

This is the lowest-risk, highest-leverage piece of plan 10-style
discovery work that fits the OpenStreetMap brief. Future tiers
(sender HQ pins, Nominatim/Overpass as a Daydream adapter, "near
me" search) reuse the geocoding plumbing this lays down.

## Scope (in)

- Geocoding pipeline (Nominatim + Redis cache + polite throttle)
- A small place-extraction LLM call per wiki page when maps is on
- Persisted `geocoded` on `CalendarEvent` and `places[]` on `Page`
- Read-only Leaflet map insets in two places
- A Settings tab with a master toggle + first-time egress note

## Scope (out, deferred)

- Routing / directions (link out to OSM or Google instead)
- Sender HQ pins (Tier B in the original brief)
- A Daydream "Nominatim/Overpass" adapter (deferred to plan 10
  follow-up)
- Full-page interactive map ("show me everything in San Francisco")
- "Near me" location-aware search (privacy-sensitive; needs its own
  user-supplied location flow that goes beyond Tier A)
- Map embeds in outbound digest emails (HTML email + maps = pain)
- Vector tiles (MapLibre). Inset maps stay raster via Leaflet to
  keep the bundle small.

## Topology

```mermaid
flowchart TB
  subgraph extract [extract]
    eventLLM[event-extract LLM] --> ce[(CalendarEvent.location)]
    placesLLM[places-extract LLM] --> pp[(Page.places[].name)]
  end
  ce --> geocode
  pp --> geocode
  subgraph geocode [geocode helper]
    nominatim[Nominatim /search] -.->|cached 30d| redis[(Redis)]
  end
  geocode -->|lat/lon, displayName| ce2[(CalendarEvent.geocoded)]
  geocode -->|lat/lon, displayName| pp2[(Page.places[].lat/lon)]
  ce2 --> api1[/api/events/upcoming/]
  pp2 --> api2[/api/pages/by-slug/]
  api1 --> emap[EventMap inset<br/>Home + /calendar]
  api2 --> placeCard[PlacesCard<br/>wiki page right rail]
  toggle[settings.maps.enabled] -->|gates| extract
  toggle -->|gates| emap
  toggle -->|gates| placeCard
```

The master toggle gates BOTH the LLM/geocoding side AND the UI
side. Off ⇒ no Nominatim calls, no map components, no extra
LLM calls.

## Data model

### `CalendarEvent` — additions

| Field | Type | Notes |
|---|---|---|
| `geocoded.lat` | Number? | WGS84 latitude, range checked at write time. |
| `geocoded.lon` | Number? | WGS84 longitude. |
| `geocoded.displayName` | String? | Nominatim's canonical name; tooltip / pin label. |
| `geocoded.at` | Date? | When we geocoded; lets us re-geocode after a refresh window. |
| `geocodeFailed` | Boolean | Sticky flag — Nominatim returned no result. Avoids retry storms. |
| `geocodeFailedAt` | Date? | Set on failure; allows a "retry after N days" cooldown. |

### `Page` — addition

```ts
places: [{
  name: String,         // canonical extracted name (e.g. "Tate Modern")
  normKey: String,      // lowercased + collapsed for dedup
  lat: Number?,
  lon: Number?,
  displayName: String?, // Nominatim canonical
  geocodedAt: Date?,
  failed: Boolean,
}]
```

The same shape per entry whether geocoded or not. Geocoded records
have lat/lon set; failures have `failed: true`. Empty array (or
absent) means we haven't run extraction yet.

Index plan: none. Place arrays are read together with the page —
no aggregations across pages by place yet (deferred to Tier B+).

### `User.settings.maps`

```ts
maps: {
  enabled: Boolean (default false),
}
```

A single toggle. Both surfaces (event map + page places) live
behind it.

## Geocoding service

`apps/worker/src/lib/geocode.ts`:

```ts
export async function geocode(
  query: string,
  opts?: { lang?: string },
): Promise<{ lat: number; lon: number; displayName: string } | null>;
```

- Calls `https://nominatim.openstreetmap.org/search?q=...&format=jsonv2&limit=1`
- Routes through `webFetchJson` so it gets the SSRF guard, the
  contactable User-Agent (`Rose/1.0 (+https://rose.local; maps)`),
  and the Redis cache (30-day TTL keyed on `caller + url + accept`).
- Polite-pool throttle: an in-process `lastCalledAt` plus a
  300ms minimum gap. Worker concurrency on the calling jobs is
  already low, so this is belt-and-braces.
- Returns `null` on no-result, network failure, or Zod parse
  failure. Callers are responsible for marking `geocodeFailed` /
  `failed: true` when they see a null.

The user-facing setting governs *whether geocode is called at all*
(callers `if (mapsEnabled)`). The geocode helper itself doesn't
look up settings — keeps it pure.

## LLM step: place extraction

A new seed instruction `extract.places` and a small worker helper
`apps/worker/src/services/extractPlaces.ts`:

```text
SYSTEM:
Extract up to 6 specific place names from the wiki page body.

Rules:
- Place names only — cities, neighbourhoods, venues, landmarks,
  parks, regions, countries, addresses. Not abstract / subjective
  ("home", "the office") unless qualified by a proper name.
- Specific over generic. "Boise State University" not "the
  university".
- One entry per distinct place; no duplicates.
- Skip senders, brands, products, people.

Output JSON: {"places": [{"name": "<place>"}, ...]}
```

- One LLM call per page, only when `settings.maps.enabled` is
  true.
- Output validated with Zod (max 8 entries; each name 1-120 chars).
- Idempotent: hashes the page contentMd; if the hash matches the
  one stored at last extraction, skip.

## Worker integrations

Two inline points (no new BullMQ queues — geocoding is fast and
infrequent):

1. **`eventExtraction.ts`** (already runs per email): after a new
   event is created, if `user.settings.maps.enabled` and
   `event.location` is present, call `geocode(event.location)`. On
   success, persist `event.geocoded`. On null, set
   `event.geocodeFailed = true; event.geocodeFailedAt = now`.

2. **`generatePage.ts`** (already runs per page-generation):
   after the page is persisted, if `user.settings.maps.enabled`,
   call `extractPlacesFromPage(userId, page)`. For each extracted
   place not already in `Page.places`, geocode it, push to the
   array.

### Re-geocoding cadence

- `geocodeFailed: true` records get retried after 7 days
  (sweeper-driven, low priority — not built in this slice).
- Successful geocodes never retry — places don't move.

## API additions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/maps/settings` | Returns `{ enabled }`. |
| `PATCH` | `/api/maps/settings` | Set `{ enabled: boolean }`; first-enable bumps a `lastAcknowledgedAt` so the UI stops showing the egress note. |
| `GET` | `/api/events/upcoming` | Already exists; response gains `geocoded` per event. |
| `GET` | `/api/pages/by-slug/:slug` | Already exists; `places` already lives on the doc. No code change there. |

The egress note's user-acknowledgement state is on the User doc so
it survives across browsers; the UI uses it to avoid showing the
note after the first opt-in.

## UI

### Library + tiles

- **Leaflet 1.9** — the map library. ~42 KB gzipped. Imported only
  by the inset components, so it's code-split with the route chunks
  (Home, Calendar, Page). Cold load on a non-map page pays nothing.
- **CARTO Voyager raster tiles** —
  `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`.
  Free, no key, generous fair-use, attribution baked into the
  control.
- **Attribution** (always shown):
  `© OpenStreetMap contributors © CARTO`.
- Markers are inline SVG (small rose-coloured pin) — avoids
  Leaflet's default-icon image-path-under-bundler dance.

### Components

#### `MapInset` (shared)

```tsx
<MapInset
  pins={[{ lat, lon, label, href? }]}
  height="180px"
  fitBounds  // default true; falls back to a default zoom on single pin
  className?
/>
```

- Mounts a Leaflet map in an effect, tears it down on unmount.
- Auto-fit bounds to all pins; one pin → reasonable zoom (z=12).
- Click a pin → router-navigate to `href` if present, else
  no-op. Hover → tooltip with `label`.

#### `EventMap`

- Rendered above `<UpcomingEvents />` in the Home right rail.
- Rendered alongside the Calendar page's existing list.
- Pulls pins from `events.filter(e => e.geocoded)`, max 12.
- Hidden when no events have coordinates.

#### `PlacesCard`

- Rendered as a new card in the wiki page right rail (next to
  Topics / Links / Images / Attachments / `CountedSection` siblings).
- Pulls pins from `page.places.filter(p => p.lat && p.lon)`.
- Hidden when empty.

### Settings → Maps (new tab)

- Single checkbox: `Enable maps for events and wiki places`.
- One-time egress note on first enable, same shape as Daydream's:
  "Place names from your events and wiki pages are sent to
  OpenStreetMap's Nominatim service for geocoding. Names are cached
  30 days. Disable any time."

## Privacy

- Off by default. The user explicitly opts in via Settings → Maps.
- Geocoding only runs when the setting is on. No backfill on
  legacy data the moment they enable — only new events / new
  page-generations after enable. (A future "geocode existing
  records now" admin button is a small follow-up.)
- All Nominatim traffic carries a contactable User-Agent and
  respects the polite-pool 1 req/sec sustained recommendation.
- The Redis cache means many users sharing a place name (e.g. the
  same conference) burn one upstream call.

## Failure modes

| Failure | Behaviour |
|---|---|
| Nominatim returns no results | Mark `geocodeFailed: true` / `failed: true` on the record; retry after 7d. |
| Nominatim 5xx / network | Same as no-result for now; per-call cache miss is the next-tick retry. |
| Zod parse fails on response | Treat as no-result, log loudly. |
| LLM place-extraction returns invalid JSON | Skip; the page just shows no places. |
| User has maps off | No LLM calls, no Nominatim calls, no UI components mounted. |
| Tile provider down | Leaflet shows the grey backdrop with attribution but no tiles. Pins still render. |

## Build order

1. Schema additions (CalendarEvent, Page, User.settings.maps).
2. Shared zod schemas + DB models.
3. `geocode()` helper + 30d cache wiring.
4. `extract.places` seed instruction + extractor service.
5. Inline-wire into `eventExtraction.ts` and `generatePage.ts` —
   gated on `settings.maps.enabled`.
6. API: `/api/maps/settings` GET/PATCH; `/api/events/upcoming`
   response shape extension.
7. `MapInset` shared component (Leaflet bootstrap + tile attribution).
8. `EventMap` for Home + Calendar.
9. `PlacesCard` for wiki page right rail.
10. Settings → Maps tab with the egress note.

## Out-of-scope reminders

- We don't store user-typed locations centrally. Geocoding is read-
  only enrichment.
- We don't auto-share user maps. Pins are per-user.
- We don't currently retry-geocode failed records — Tier A keeps
  the model simple. The retry sweep is a separate, small follow-up.

## Open questions (deferred)

- **Should the page right-rail card be hideable per-page?** Some
  pages have place names that aren't really about places (e.g.
  "Slack" mentioned in passing), and the LLM might extract them
  anyway. v1 ships without a per-page toggle; a "Hide map for this
  page" affordance is a small follow-up if usage data shows the
  card is noisy.
- **Should we cluster pins on dense maps?** Probably not at
  Tier A's scale — events maxed at 12 pins, pages typically <6.
  Defer until usage requires it.
- **Tile pre-fetch / offline?** Plan 11 is online-only. PWA + map
  caching is a separate plan.
