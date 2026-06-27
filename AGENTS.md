# pixies (https://github.com/podikoglou/pixies)

Pixies is a web chat app that answers natural-language place questions via
OpenStreetMap data.

`bun` workspace monorepo: `@pixies/core` (kernel — config, agent, SSE event
types, OSM clients, tools), `@pixies/server` (Bun HTTP server + SSE streaming),
`@pixies/web` (React SPA). See CONTRIBUTING.md for the full layout and scripts.

Before pushing any PR: run `bun run typecheck && bun run lint && bun run format:check && bun run test` locally.
Before merging any PR: `gh pr checks <n> --watch` and only merge if CI is green.
The full triad (typecheck/lint/format) runs in CI; `format:check` is the one most often skipped and fails CI.

For code conventions, see docs/CONVENTIONS.md.
For contributing guidelines, see CONTRIBUTING.md.
