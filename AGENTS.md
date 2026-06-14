# pixies

Pixies is an OSM-querying AI agent built on `@earendil-works/pi-tui`:
a terminal chat that answers natural-language place questions via OpenStreetMap
data.

## Toolchain

This project uses `bun`.

## Code quality

Root scripts (run from anywhere in the repo):

- `bun run typecheck` — `tsc --noEmit` across `@pixies/*`
- `bun run format` / `bun run format:check` — oxfmt across `@pixies/*`
- `bun run lint` / `bun run lint:fix` — oxlint across `@pixies/*`

Formatter and linter are installed per package (each owns a `format`/`lint`
script scoped to `src/`); shared config lives at the repo root
(`.oxfmtrc.json`, `.oxlintrc.json`) and is picked up via nested-config walk-up.
Style: tabs, double quotes, trailing commas, semicolons.

A `lefthook` pre-commit hook runs piped **format → typecheck → lint** and stops
on the first failure. Formatting uses `stage_fixed`, so oxfmt's changes are
re-staged into the commit automatically. typecheck runs unconditionally;
format/lint only touch staged JS/TS files. Skip the hook with `--no-verify` or
`LEFTHOOK=0`.


## Where to look

**TUI framework contract and conventions** → `docs/PI-TUI.md`. Read this before
writing any component code; pi-tui's mental model is non-obvious.
