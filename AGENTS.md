# pixies (https://github.com/podikoglou/pixies)

Pixies is a web chat app that answers natural-language place questions via
OpenStreetMap data. The original TUI interface (`@pixies/tui`) is kept for
legacy reference only.

This is a `bun` workspace monorepo with four packages:

| Package          | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `@pixies/core`   | Shared kernel — config, agent factory, SSE event types, OSM clients, tools |
| `@pixies/server` | Bun HTTP server — conversation API, SSE streaming, static web serving      |
| `@pixies/web`    | React SPA — the primary chat interface                                     |
| `@pixies/tui`    | Legacy terminal interface (unmaintained)                                   |

Build: `bun run typecheck` / Format: `bun run format` / Lint: `bun run lint`

For code conventions, see docs/CONVENTIONS.md.
For contributing guidelines, see CONTRIBUTING.md.
For the legacy TUI framework contract, see docs/PI-TUI.md.
