# pixies (https://github.com/podikoglou/pixies)

Pixies is a web chat app that answers natural-language place questions via
OpenStreetMap data.

This is a `bun` workspace monorepo with three packages:

| Package          | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `@pixies/core`   | Shared kernel — config, agent factory, SSE event types, OSM clients, tools |
| `@pixies/server` | Bun HTTP server — conversation API, SSE streaming, static web serving      |
| `@pixies/web`    | React SPA — the primary chat interface                                     |

Build: `bun run typecheck` / Format: `bun run format` / Lint: `bun run lint`

For code conventions, see docs/CONVENTIONS.md.
For contributing guidelines, see CONTRIBUTING.md.
