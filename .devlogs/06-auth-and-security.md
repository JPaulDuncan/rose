# 06 — Auth & Security

## Sessions

- **Access token**: JWT, 15 min, returned in JSON, stored in memory in the SPA, sent as
  `Authorization: Bearer <token>` on every request.
- **Refresh token**: JWT, 7 days, set as `httpOnly; SameSite=Lax; Secure (in prod)`
  cookie scoped to `/api/auth`. The SPA calls `/api/auth/refresh` on boot and on any
  401, and gets a fresh access token.
- **Logout** clears the cookie. We do not maintain a server-side blocklist (yet); a
  stolen access token is valid until it expires.

## Password handling

- Argon2id via `argon2`. Never log or echo password fields. Logger uses `pino` with no
  serialization of the request body.
- Login throttling via `express-rate-limit` (30 reqs / 15min / IP).

## Source secrets

IMAP passwords and Gmail refresh tokens are encrypted at rest with AES-256-GCM. The
key is derived from `ENCRYPTION_KEY` via `scryptSync`. The `encryptedConfig` field is
`select: false`, so it never appears in API responses unless explicitly requested by
the worker.

## Webhook auth

Each webhook source has its own `apiToken`. We store only `sha256(token)`. The raw
token is shown once in the UI on creation. Compromise of the database does not leak
the token; rotating means deleting the source and creating a new one.

## CORS & CSP

- CORS allows only `WEB_ORIGIN` with credentials.
- Helmet ships sane defaults; we don't relax CSP. The web image proxies `/api` through
  Nginx so cookies are first-party.

## Threat model (concise)

| Attack | Mitigation |
| --- | --- |
| Stolen access token | Short TTL (15m); refresh in cookie |
| Stolen refresh cookie | `httpOnly`, `Secure`, scoped to `/api/auth`, rotated on use |
| SQL/Mongo injection | Mongoose strict queries + Zod-validated input |
| Webhook flooding | Rate limit + per-source token |
| Unsafe LLM output | All page output is Markdown rendered by `react-markdown` (no raw HTML); no `dangerouslySetInnerHTML` |
| XSS on rendered email content | We never render raw email HTML; only LLM-rewritten markdown |
