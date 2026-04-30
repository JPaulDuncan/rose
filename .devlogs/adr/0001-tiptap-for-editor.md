# ADR 0001 — TipTap for the wiki editor

## Status
Accepted, 2026-04-30.

## Context
We need a rich-text editor for wiki pages that supports markdown round-trips, slash
commands, mentions/backlinks, and a small bundle. Candidates: TipTap, Lexical, Slate,
ProseMirror direct, plain `<textarea>` + remark.

## Decision
Use **TipTap** (StarterKit + Placeholder + Link) for v1. Render with `react-markdown`
in view mode, keep TipTap only for edit mode.

## Consequences
- We round-trip markdown through ad-hoc HTML conversion in `routes/Page.tsx`. This loses
  fidelity for nested lists and code fences — acceptable for v1; add `remark`-based
  serializers in v2.
- TipTap's plugin ecosystem covers backlinks (`[[`) and slash menus when we get there.
- Bundle adds ~120kB gz. Fine.
