# Contributing to Pixies

## Getting started

1. Fork and clone the repo
2. Install deps: `bun install`
3. Run the app: `bun run dev`

## Development

This project uses `bun`.

- **Build:** `bun run typecheck`
- **Format:** `bun run format`
- **Lint:** `bun run lint`

## Filing issues

Use the provided issue templates:

- **Bug report** — something's broken.
- **Deepen** — structural improvement (better seams, testability, locality, type safety).
- **Feature request** — new functionality.

The "Deepen" template is the most common around here. If your issue is about
refactoring, reorganising modules, or making code testable, use that one.

## Code conventions

- Follow existing patterns — check neighbouring files before introducing new ones.
- Prefer small, atomic commits.
- Write well-documented code and keep comments up to date.
- Never commit secrets or keys.
- Run `bun run typecheck`, `bun run format`, and `bun run lint` before pushing.

## Architecture

See `docs/adr/` for architecture decisions.
