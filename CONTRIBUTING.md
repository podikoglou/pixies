# Contributing to Pixies

## Architecture

Monorepo with three packages:

| Package          | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `@pixies/core`   | Core. config, agent factory, SSE event types, OSM clients, tools. |
| `@pixies/server` | Bun HTTP server. Conversation API, SSE streaming.                 |
| `@pixies/web`    | React SPA. Chat interface.                                        |

## Reference docs

| Doc | Answers |
|---|---|
| [docs/api/sse.md](docs/api/sse.md) | the conversation + SSE wire protocol |
| [docs/errors.md](docs/errors.md) | the error taxonomy, wire invariant, and tag schema |
| [docs/posthog-privacy.md](docs/posthog-privacy.md) | what telemetry is collected and how to disable it |
| [docs/posthog-dashboards.md](docs/posthog-dashboards.md) | the PostHog dashboards and alerts runbook for agent-loop observability |
| [docs/DOCKER.md](docs/DOCKER.md) | deployment, env vars, and token-budget semantics |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | code conventions |
| [docs/adr/](docs/adr/) | architecture decision records |

## Getting started

1. Fork and clone the repo
2. Install dependencies: `bun install`
3. Set up environment: `cp .env.example .env` and fill in at minimum `PIXIES_MODEL` and `PIXIES_API_KEY`
4. Install git hooks: `lefthook install`

## Running locally

Pixies needs two processes running in development:

- `bun run dev:server`
- `bun run dev:web`

## Development Scripts

| Command                | Does                            |
| ---------------------- | ------------------------------- |
| `bun run typecheck`    | TypeScript type-checking (tsgo) |
| `bun run format`       | Format with oxfmt               |
| `bun run format:check` | Check formatting (CI)           |
| `bun run lint`         | Lint with oxlint                |
| `bun run test`         | Run tests (per-package)         |
| `bun run build:web`    | Production web build            |
| `bun run db:generate`  | Generate Drizzle migrations     |
| `bun run db:migrate`   | Apply Drizzle migrations        |

## Pre-commit hooks

Lefthook runs on every commit (format → typecheck → lint). Setup: `lefthook install`

## Code conventions

Follow [docs/CONVENTIONS.md](docs/CONVENTIONS.md). Some architecture decisions are documented in [docs/adr/](docs/adr/).

## Adding a tool

1. Create `packages/core/src/tools/tool-<name>.ts` — export a module built with `defineTool`. Each tool declares the context it depends on (`TContext` — an object the tool types itself, e.g. `{ nominatim }` or `{ overpass }`; `void` for a context-less tool); `defineTool` bundles:
   - `execute` — the tool's behavior. Its first argument is the context (destructure your deps out of it); the remaining arguments are pi's `execute` signature.
   - `detailsSchema` — TypeBox schema for the structured result
   - `parse` — validates `unknown` details against the schema and returns a typed result variant (or `null`); `parseSchema(schema, (d) => …)` does the validate + narrow + map in one step
   
   See [tool-geocode.ts](./packages/core/src/tools/tool-geocode.ts) for an example.

2. Register in `packages/core/src/tools/index.ts` — add one entry to the `TOOL_MODULES` const and one `module.build({ … })` line in `createTools`. The build list is keyed by tool name with a mapped type over `TOOL_MODULES`, so the two must stay in sync (missing/extra keys are compile errors).

3. Test it: `packages/core/src/tools/<name>.test.ts` — construct via `module.build({ …context })` (or `module.build()` for context-less tools); see [display-map.test.ts](./packages/core/src/tools/display-map.test.ts).



## Testing

Each package has its own test suite:

```sh
bun run --filter '@pixies/core' test
bun run --filter '@pixies/server' test
bun run --filter '@pixies/web' test
```

Tests run on CI for every PR.

## Filing issues

Use the issue templates:

| Template            | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| **Bug report**      | Something's broken                                     |
| **Deepen**          | Structural improvement (refactors, testability, seams) |
| **Feature request** | New functionality or capability                        |

The "Deepen" template is the most common. If your issue is about refactoring,
reorganising modules, or making code testable, use that one.

## Pull request process

PRs use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md). Agent-authored
PRs should follow the `pr` skill for the body-style rules (what to include vs. what's
already visible in the GitHub UI).

- Run `bun run typecheck`, `bun run format`, and `bun run lint` before pushing (though lefthook should run that by itself)
- Never commit secrets or keys (`.env` is gitignored)
- Write well-documented code and keep comments up to date
