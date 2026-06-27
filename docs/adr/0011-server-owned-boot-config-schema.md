# ADR-0011: Server-owned boot config schema

**Status:** Accepted — 2026-06-27

## Context

`@pixies/core`'s `PixiesConfigSchema` governs every `PIXIES_*` var through `readConfigFromEnv`'s `Value.Default` + `Value.Parse` pipeline. Two server boot paths fall outside it: where the server serves the web SPA from (`PIXIES_WEB_DIST`) and where Drizzle reads migration metadata (`PIXIES_MIGRATIONS_FOLDER`). These were read with `process.env.X ?? fallback` at module load in `packages/server/src/index.ts` — declared nowhere in a schema, absent from `.env.example`, and captured before `startServer` runs, so tests could not override them through the established `opts.config` seam.

The open question is ownership: fold the two paths into core's `PixiesConfigSchema`, or declare a separate, server-owned schema.

## Decision

Declare a server-owned TypeBox schema, `ServerConfigSchema` in `packages/server/src/config.ts`, composed alongside `ResolvedPixiesConfig`. `readServerConfigFromEnv` applies the same `Value.Default` + `Value.Parse` pipeline core uses, and `startServer` resolves it from `opts.serverConfig ?? readServerConfigFromEnv()` — a seam parallel to `opts.config`.

## Rationale

1. **Neither path has a consumer in the kernel.** `webDist` is a UI-asset concept — the directory the server serves the SPA bundle from — excluded by core's stated "No UI or HTTP dependencies" boundary. `migrationsFolder` is subtler: core depends on `drizzle-orm` and owns the client factory (`createDb`) and the schema, so drizzle is *not* server-only. But core exports `createDb`, not `migrate`; the migrations folder is read only by `migrate()`, which runs exclusively in the server boot path. The path is therefore a server runtime concern — meaningless to anything core exposes — even though the library it parameterizes lives in core.
2. **Consistency without coupling.** The server already depends on `typebox`, so a second schema is cheap and reuses the identical `Value.Default` / `Value.Parse` / `Static<T>` patterns — one set of conventions, two owners split along the package boundary.
3. **Deletion test.** Delete `ServerConfigSchema` and `readServerConfigFromEnv`: the two paths lose their schema home, their `.env.example` documentation, and the `opts.serverConfig` injection seam — the three gaps this decision exists to close.

## Consequences

**Positive:**

- Every `PIXIES_*` var now flows through a TypeBox schema with a single defaults/description site.
- `.env.example` documents the full operator surface; no hidden knobs.
- Both boot paths are injectable in tests through `opts.serverConfig`, like `opts.config` for the rest.

**Negative:**

- Two config types and two readers exist (`ResolvedPixiesConfig` / `ServerConfig`). The split reflects the package boundary rather than fragmenting one concern, so it is the cost of keeping core clean.
- `PIXIES_WEB_DIST` unset or empty resolves to the absolute `import.meta.dir`-relative default rather than cwd; serving from the working directory requires setting the var explicitly.

## Durability

This holds while core stays free of UI/HTTP dependencies and these two remain server boot paths. A future server-only boot path joins `ServerConfigSchema`; a config var that core genuinely needs to consume belongs in `PixiesConfigSchema`.

## Alternatives considered

- **Fold into core's `PixiesConfigSchema`.** Rejected — `webDist` violates core's no-UI boundary, and `migrate()` (the sole consumer of `migrationsFolder`) is server-side, so the path has no kernel consumer.
- **Flatten `webDist` / `migrationsFolder` into individual `StartServerOptions` fields.** Rejected — loses the single schema home and the shared defaults/validation, and breaks parallelism with the existing `opts.config?: ResolvedPixiesConfig` seam.

## References

- Resolves the "core vs server owns the declaration" question posed in #231.
- `packages/server/src/config.ts` — `ServerConfigSchema`, `readServerConfigFromEnv`.
- `packages/server/src/index.ts` — `StartServerOptions.serverConfig`, resolution in `startServer`.
- Supersedes nothing; extends the config-schema approach of ADR-0006 to a server-owned surface.
