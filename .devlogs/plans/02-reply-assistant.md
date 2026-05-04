# 02 — Reply assistant

LLM-drafted email replies that pull context from the relevant wiki page
and the address-book entry for the sender. The user gets a stream of
tokens they can edit and either copy out or send via the connected
outbound transport (IMAP-SMTP / Gmail API).

## Goal

Close the loop on knowledge work. Today the wiki tells you *what was
said*; the reply assistant uses it to draft *what you should say back*.

## Topology

```mermaid
flowchart LR
  emailView[/e/:id email view] -->|Click "Draft reply"| api
  api -->|fetch email + page + sender| mongo
  api -->|/api/generate stream| ollama
  api -->|SSE tokens| emailView
  emailView -->|Send| outbound[Outbound transport]
  outbound -->|SMTP / Gmail API| upstream[(Mail server)]
```

Drafting is read-only — the user can copy the result or hand it to the
outbound path explicitly. We never auto-send.

## Data model

Two new fields on `Email`:

| Field | Type | Notes |
| --- | --- | --- |
| `draftReply` | String? | Last LLM draft; persisted so reload doesn't lose work |
| `draftReplyMeta` | Mixed? | `{ model, generatedAt, edits: number }` |

One new collection for sent mail (so we have an audit trail, and so
threads we replied to are visible across devices):

### `outboundMessages`
| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | |
| `userId` | ObjectId | indexed |
| `inReplyToEmailId` | ObjectId | indexed |
| `to`, `cc`, `bcc` | [{name, address}] | |
| `subject` | String | |
| `bodyMd` | String | composed body (Markdown) |
| `bodyHtml` | String? | rendered + sanitised; sent as multipart/alternative |
| `status` | enum: `queued`, `sent`, `failed` | |
| `transport` | enum: `smtp`, `gmail` | |
| `error` | String? | |
| `sentAt` | Date? | |
| `messageId` | String? | upstream Message-ID, captured back |

## Outbound transport

For v1, support two transports:

1. **SMTP** — when the user has an IMAP source configured, derive the
   matching SMTP host (`smtp.<domain>` heuristic + override field) and
   reuse the encrypted credentials. `nodemailer` for the send.
2. **Gmail API** — when a Gmail OAuth source is connected, call
   `users.messages.send` with the configured refresh token.

`Source` gains optional SMTP fields: `smtpHost`, `smtpPort`, `smtpSecure`.
For Gmail OAuth we already have what we need.

## API surface

```
POST  /api/emails/:id/draft-reply         SSE — stream tokens
POST  /api/emails/:id/draft-reply/save    persist current draft
DELETE /api/emails/:id/draft-reply        clear

POST  /api/outbound                       send (queued via worker)
GET   /api/outbound                       list (paginated, by inReplyToEmailId)
GET   /api/outbound/:id                   detail (status, error)
```

Body of `POST /api/outbound`:
```ts
{
  inReplyToEmailId: string,
  to: { name?: string, address: string }[],
  cc?: { name?: string, address: string }[],
  bcc?: { name?: string, address: string }[],
  subject: string,
  bodyMd: string,
  transport?: 'smtp' | 'gmail',  // auto-pick if absent
}
```

## Worker

New queue `rose.send-outbound`. Processor:

1. Load `OutboundMessage`.
2. Pick transport (explicit or first matching active Source).
3. Render Markdown to sanitised HTML (DOMPurify equivalent server-side).
4. Send. On success, capture `Message-Id` and set `status = 'sent'`.
5. On failure, mark `failed` with the error; don't retry automatically
   — the user fixes and resubmits.

## Prompt

New system instruction `reply.draft` (scope: `reply`, new):

```
You are drafting an email reply on behalf of {{user_display_name}}.

ORIGINAL EMAIL
- From: {{from}}
- Subject: {{subject}}
- Sent: {{date}}
- Body:
"""
{{body}}
"""

RELEVANT WIKI CONTEXT (cite as [pN] only if you use it)
{{context}}

WHAT THE USER KNOWS ABOUT THE SENDER
{{sender_brief}}

REQUIREMENTS
- Match the register of the original. Casual stays casual.
- Be concise. No filler ("Thanks for reaching out!" type lines).
- Open with the answer; supporting detail after. Sign off naturally.
- Markdown only; no markdown headings.
- If the original asks something that requires information you don't
  have, leave a `[TODO: ...]` placeholder rather than inventing.
```

`{{context}}` is the top-3 retrieved page snippets via the same kNN
path Ask-the-Wiki uses (capped to ~3KB total). `{{sender_brief}}` is
the Sender's stored summary if any.

## UI

On the email detail page (`/e/:id`), add a "Draft reply" panel that:

- Streams the LLM output token-by-token into a TipTap editor.
- Shows the citations the LLM used as inline pills (clickable, just
  like in chat).
- Has a `[Send]` action when an outbound transport is configured —
  otherwise `[Copy]` only, with a banner explaining how to enable
  sending.
- Shows the user's message-history with this sender (last 3 outbound
  messages) so they can match tone.

Compose-from-scratch is out of scope for v1 — drafting always happens
from an existing email so the system has a real anchor.

## Outbound settings

A new "Outbound" panel in Settings → Sources lets the user:

- Set SMTP host/port/secure for each IMAP source.
- "Test send" — sends a probe to the user's own address.
- Set a default From: name + signature.

## Out of scope

- Threaded reply rendering (the Reply lives on the email row, not as a
  threaded sub-message).
- Attachments on outbound mail.
- Schedule-send.
- Templates / snippets.

## Open questions

1. **Persistence of drafts** — per-email is simplest, but a user might
   want to discard and try another angle. Provide an "edit history"
   inside `draftReplyMeta.edits` and surface "Regenerate" without
   blowing away the previous draft.
2. **Privacy** — the LLM sees the original email *and* relevant wiki
   pages. For Anthropic/OpenAI users that's a third-party round-trip.
   Add a per-page opt-out flag (`flags.privateNoLLM`) so sensitive
   pages get excluded from chat + reply context.
3. **Tone modeling** — should we fine-tune on the user's own outbound
   history? Powerful but expensive and stateful. Defer.

## Verification

- Cold-start (no wiki, no sender record): the draft still produces a
  reasonable response from just the original email.
- TODO placeholder integrity: the model emits `[TODO: ...]` rather
  than fabricating when info is missing — verified via prompt eval set.
- Send guardrail: a `failed` message stays in the user's outbox; no
  silent retries that could double-send.
