# pixies (https://github.com/podikoglou/pixies)

Pixies is an OSM-querying AI agent built on `@earendil-works/pi-tui`:
a terminal chat that answers natural-language place questions via OpenStreetMap
data.

This project uses `bun`.

Build: `bun run typecheck` / Format: `bun run format` / Lint: `bun run lint`

A `lefthook` pre-commit hook runs format → typecheck → lint, stopping on the
first failure. Formatting uses `stage_fixed` so changes are re-staged automatically.
Skip with `--no-verify` or `LEFTHOOK=0`.

For the TUI framework contract, see docs/PI-TUI.md
For contributing guidelines, see CONTRIBUTING.md
