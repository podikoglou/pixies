# pixies (https://github.com/podikoglou/pixies)

Pixies is a web chat app that answers natural-language place questions via
OpenStreetMap data.

This is a `bun` workspace monorepo with three packages:

| Package          | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `@pixies/core`   | Shared kernel — config, agent factory, SSE event types, OSM clients, tools |
| `@pixies/server` | Bun HTTP server — conversation API, SSE streaming, static web serving      |
| `@pixies/web`    | React SPA — the primary chat interface                                     |

Build: `bun run typecheck` / Format: `bun run format` / Lint: `bun run lint` / Test: `bun run test`

Before pushing any PR: run `bun run typecheck && bun run lint && bun run format:check && bun run test` locally.
Before merging any PR: `gh pr checks <n> --watch` and only merge if CI is green.
The full triad (typecheck/lint/format) runs in CI; `format:check` is the one most often skipped and fails CI.

For code conventions, see docs/CONVENTIONS.md.
For contributing guidelines, see CONTRIBUTING.md.
