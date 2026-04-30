# 05 — UX Spec

## Information architecture

- **Home** — recent pages, empty-state with one-click upload.
- **Inbox** — drag-and-drop ingestion, list of raw emails with status pills, link to
  generated page when available.
- **Page** — view/edit toggle, summary + tags inline, revision history drawer.
- **Search** — single field, hybrid by default, mode toggle, snippet previews.
- **Graph** — force-directed view, click a node to open the page.
- **Settings** — Account, Sources, Instructions, Models. Tabbed.

## Keyboard map

| Key | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Open command palette |
| `/` | Jump to search |
| `g h` | Home |
| `g i` | Inbox |
| `g g` | Graph |
| `g s` | Settings |
| `n` | New ingestion (Inbox upload) |

Sequence keys (`g h`, `g i`) are debounced; the buffer clears after 800ms.

## Command palette

Built on `cmdk`. Always shows: navigation, "Upload an email", and the user's pages
(top 50 by recency). The palette is the main source of truth for power-user flows;
adding a new global action means adding a `Command.Item` here.

## Theming

Three modes: `light`, `dark`, `system` (default). Stored in `localStorage` under
`rose.theme`. The `<html>` element gets `class="dark"` when the resolved mode is dark,
which Tailwind keys off via `darkMode: 'class'`.

## Toasts and progress

`react-hot-toast` for transient feedback. The `IngestionDrawer` is the long-form
progress affordance: it streams tokens from the worker via SSE, shows the live JSON
being built, and exposes a single "Open page" CTA when generation completes.

## Empty states

- Home: shows "Upload email" + "Connect a source"
- Inbox: encourages upload, mentions Ollama
- Search: prompts for ≥2 chars
- Graph: tells the user to generate pages first

These states matter because the new-user flow has zero data; no empty cards, no spinners
without context.

## Accessibility notes

- All interactive elements use semantic HTML (`button`, `a`, `label`).
- The dropzone, palette, and modals trap-but-don't-hijack focus.
- Color tokens (`rose`, `ink`) carry sufficient contrast in both themes.
- We respect `prefers-reduced-motion` via Tailwind's `motion-reduce` variants where we
  add animations.
