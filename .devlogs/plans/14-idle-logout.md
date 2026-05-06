# Plan 14 — Idle logout (client + server)

**Status:** Shipped (G4 of plan 12 audit completed the server side).
Retrospective spec.

---

## Goal

After N minutes of user inactivity in the SPA, log the session out
and force re-auth. Defends against unattended browser sessions on
shared workstations and limits the lifetime of a stolen access JWT.

## Configuration

Two env vars; both default to 5 minutes:

| Var | Side | Default |
|---|---|---|
| `VITE_IDLE_TIMEOUT_MINUTES` | apps/web (Vite build-time) | 5 |
| `IDLE_TIMEOUT_MINUTES`      | apps/api (runtime)         | 5 |

Set client and server to the same value; misalignment isn't
catastrophic but produces confusing UX (e.g. SPA times out at 5
minutes but server keeps accepting tokens for 10).

Set the server-side var to `0` to disable enforcement entirely
(client-side timer keeps working).

## Client side

`apps/web/src/lib/useIdleLogout.ts` — React hook mounted under
`ProtectedShell`.

- Listens for `mousemove` / `mousedown` / `keydown` / `scroll` /
  `touchstart` on `document` (passive).
- Records `Date.now()` to localStorage (throttled 1s) on every
  activity, plus a `storage` event listener so other tabs see fresh
  activity from this one. Avoids the "wrong tab logs everyone out"
  failure mode.
- Single timer scheduled for the next-fire moment + 250 ms safety.
- On fire: shows a "Logged out for inactivity" toast, calls
  `useAuth.logout()`, navigates to `/login` (replace).
- Failure modes:
  - Malformed env value → falls back to default (fail-closed).
  - localStorage unavailable (private browsing) → in-memory only;
    cross-tab freshness lost, single tab still works.
- Hook keyed on `user.id` so login/logout cycles re-arm without
  leaking timers.

## Server side

`apps/api/src/middleware/auth.ts`. Pairs the access-token JWT
verification with a Redis-backed activity check.

```
KEY:    rose:idle:<userId>
VALUE:  <ms since epoch of last seen activity>
TTL:    2× IDLE_TIMEOUT_MINUTES (so the key ages out cleanly)
```

### Per-request flow
1. Verify JWT signature + extract `sub`.
2. If `IDLE_TIMEOUT_MINUTES <= 0`, skip the check entirely (env-disabled).
3. `GET rose:idle:<userId>`. If the value's age > timeout → 401
   `session_idle_timeout`. Clear the key.
4. Throttle: if last-write was > 5 s ago, write the new timestamp
   (in-process Map records the local last-write to keep most
   requests off Redis).
5. `next()`.

### Session anchors
- **Login** + **register** + **refresh** all explicitly call
  `recordActivity(userId)` so the very next request from a
  fresh session doesn't fail the idle check on the missing-key
  path.
- **Logout** calls `clearActivity(userId)` (best-effort — the
  refresh-cookie clear is the load-bearing piece). This forces
  any in-flight access JWT held elsewhere to stop working
  immediately.

### Failure mode
- Redis hiccup → middleware fails open (continues). The access JWT
  TTL (15 min) and the client-side timer remain as outer bounds.

## What this does NOT solve

- **Same-IP token replay during the idle window.** If an attacker
  captures a fresh token and uses it within the timeout, they
  can keep it alive by making requests. The throttled-write
  approach treats their requests as legitimate activity.
  Mitigation would be IP-pinned tokens, which has its own UX cost.
- **Mobile background suspension.** A phone that sleeps mid-session
  doesn't generate `storage` or activity events; the SPA fires
  the logout when it wakes. That's actually correct (the user
  wasn't there), just worth knowing.
- **Long-running streaming endpoints.** SSE streams (job progress,
  models pull) hold the connection open but don't issue new
  authenticated requests. Idle check runs at connect time only.

## Future tweaks

- Surface a "your session will expire in 30 s" banner before
  firing logout — the audit hasn't called for it but it'd be
  cleaner UX than a sudden redirect.
- Per-route exemptions (e.g. `/api/auth/refresh` should always
  succeed regardless of idle state — it currently does because it
  uses cookie auth, not the bearer middleware, but the symmetry
  is worth documenting).
