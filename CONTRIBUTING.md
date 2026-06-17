# Contributing to Pixies

## Architecture

Monorepo with three packages:

| Package          | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `@pixies/core`   | Core. config, agent factory, SSE event types, OSM clients, tools. |
| `@pixies/server` | Bun HTTP server. Conversation API, SSE streaming.                 |
| `@pixies/web`    | React SPA. Chat interface.                                        |

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

Follow [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

Generally:

- kebab-case filenames
- Prefer [9ui](https://9ui.dev) UI primitives over custom styling
- Use [pqoqubbw/icons](https://icons.pqoqubbw.dev/) for icons

Some architecture decisions are documented in [docs/adr/](docs/adr/).

## Adding a tool

1. Create `packages/core/src/tools/tool-<name>.ts` — export a `ToolModule` and a factory function. The module bundles everything the tool needs:
   - `factory` — creates the `AgentTool` with OSM clients injected
   - `detailsSchema` — TypeBox schema for the structured result
   - `parse` — validates `unknown` details against the schema and returns a typed result variant (or `null`)
   - `summarize` — produces a one-line display summary from the parsed result
   
   See [tool-geocode.ts](./packages/core/src/tools/tool-geocode.ts) for an example.

2. Register in `packages/core/src/tools/index.ts` — add one entry to the `TOOL_MODULES` const and update `ToolNameSchema` and `ToolDetailsMap`.

3. Preferably test: `packages/core/src/tools/<name>.test.ts` (see [display-map.test.ts](./packages/core/src/tools/display-map.test.ts))

That's it. The compiler derives `ToolName`, `ToolResult`, `ToolRegistry`, and the discriminated union from `TOOL_MODULES`. Missing `parse` or `summarize` on your module is a type error — you can't forget them.

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

- Run `bun run typecheck`, `bun run format`, and `bun run lint` before pushing (though lefthook should run that by itself)
- Never commit secrets or keys (`.env` is gitignored)
- Write well-documented code and keep comments up to date
