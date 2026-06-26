# ADR-0006: Config schema uses TypeBox

**Status:** Accepted — 2026-06-24

## Context

ADR-0002 (originally "TypeBox schemas in core for shared type contracts", 2026-06-15) established TypeBox as the single validation library for tool parameter schemas and SSE event schemas. Its 2026-06-15 **Revision** carved out one exception: **configuration validation** (`packages/core/src/config-schema.ts`) moved to **Zod**. The stated reason was that config needs *two* types — input (`PixiesConfig`, defaults not yet applied) and resolved (`ResolvedPixiesConfig`, defaults filled) — and Zod expresses that split directly via `z.input` / `z.output`, whereas TypeBox's `Static<T>` yielded a single type and "cannot model the defaults transform."

This made `zod` a **second** validation library in `@pixies/core`, kept solely for one schema. Three things have since changed:

1. **The input type was never needed.** ADR-0002's own 2026-06-17 note recorded that `PixiesConfig` (`z.input`) was never exported and had no consumers — dead surface area. The input/output split that justified Zod modeled a distinction nobody used. Only `ResolvedPixiesConfig` (`z.output`) is public.
2. **TypeBox gained directional static types.** TypeBox 1.x ships `StaticDecode<T>` (input direction) and `Static<T>` ≡ `StaticEncode<T>` ≡ `StaticParse<T>` (output direction), closing the "single `Static<T>`" gap ADR-0002 cited.
3. **The config domain now follows the same `Value.*` patterns** the rest of core uses for transcript/SSE/OSM schemas, so Zod is the only outlier.

This is the third swing at the config-library question (after ADR-0002's Revision → this), so the ADR must record *why it sticks this time*.

## Decision

The config schema in `packages/core/src/config-schema.ts` is rewritten in TypeBox, and `zod` is dropped from `@pixies/core`'s direct dependencies. Concretely:

- `PixiesConfigSchema = Type.Object({...})` with `Type.String` / `Type.Integer` / `Type.Boolean` / `Type.Union([Type.Literal(...)])` / `Type.Optional(...)`.
- `ResolvedPixiesConfig = Static<typeof PixiesConfigSchema>` — the **output** type, shape-identical to the prior `z.output`.
- Defaults are expressed as `Type.X({ default: N, ... })` (plain, **not** wrapped in `Type.Optional`) so resolved knobs stay required `number` / `string`; only `contactEmail` and `discordWebhookUrl` (genuinely optional, no default) use `Type.Optional`.
- Defaults are applied via the pipeline `Value.Parse(PixiesConfigSchema, Value.Default(PixiesConfigSchema, raw))` in `agent.ts:readConfigFromEnv`. Unlike Zod's `.parse()`, `Value.Parse` does **not** apply defaults on its own, so `Value.Default` runs first.
- Numeric coercion is explicit `Number(envVar)` in `readConfigFromEnv` (via a `num()` helper) — **not** `Value.Convert` (which silently truncates `"3.5"` → `3`).
- The provider-prefix check stays in the schema via `Type.Refine(Type.String({pattern}), check, errCb)` (mirrors the defense-in-depth guard in `agent.ts:resolveModel`).

## Rationale

1. **Deletion test.** Delete `zod` from `packages/core/package.json` and revert nothing else: config parsing still works identically, the test suite stays green, and `ResolvedPixiesConfig` keeps the same shape. `zod` leaves our direct deps while remaining transitive via the provider SDKs (`@mistralai/mistralai` direct; `openai` + `@anthropic-ai/sdk` optional-peer) — so nothing in `node_modules` even disappears for those consumers.

2. **The input/output distinction was dead.** `PixiesConfig` (`z.input`) was never exported and had zero references (confirmed by grep for `\bPixiesConfig\b`). TypeBox's inability to model *two* types modeled a problem that didn't exist. `ResolvedPixiesConfig = Static<...>` reproduces `z.output` exactly.

3. **Why it sticks this time.** Every Zod config feature has a verified TypeBox equivalent:
   - `z.object` / `z.string().regex().superRefine` → `Type.Object` / `Refine(Type.String({pattern}), check, errCb)`.
   - `z.string().url()` / `.email()` → `Type.String({ format: "url" | "email" })` (asserted by `Value.Parse` by default).
   - `z.coerce.number().int().min().max()` → `Type.Integer({ minimum, maximum })` + explicit `Number()` coercion.
   - `z.enum([...]).default(...)` → `Type.Union([Type.Literal(...)], { default })` (output is the literal union).
   - The defaults transform → `Value.Default` + `Value.Parse`.
   - The one tricky case — `z.coerce.number().int()` rejecting `"3.5"` — is solved by explicit `Number()` (which preserves `3.5`, then `Type.Integer` rejects it). `Value.Convert` was rejected because it silently truncates `"3.5"` → `3`.

4. **One library, one set of patterns.** Config now uses the same `Value.*` pipeline the rest of core uses. ADR-0002 returns to a single global rule (TypeBox everywhere in core).

## Consequences

**Positive:**

- `zod` is no longer a direct dependency of `@pixies/core` — one validation library across the whole kernel.
- Config follows the same `Value.Default` / `Value.Parse` / `Static<T>` patterns as transcript, SSE, and OSM schemas.
- ADR-0002's "TypeBox for config is rejected" carve-out is removed; the ADR returns to a single, uniform rule.

**Negative:**

- `Value.Default` must be called **explicitly** before `Value.Parse` — Zod applied defaults inside `.parse()`. This is documented in `readConfigFromEnv`.
- `Value.Default` **mutates its input in place**. Mitigated here because `readConfigFromEnv` builds a fresh object literal per call; the behavior is documented at the call site.
- TypeBox's thrown error type is `ParseError` (from `typebox/value`) with the structured message at `err.cause.errors[0].message` — **not** Zod's `ZodError` with `.issues[0].message`. The one test that asserted the shape (`agent.test.ts`) is updated accordingly.

## Durability

This decision holds for as long as:

- `typebox` remains a direct dependency of `@pixies/core` (it already is, for tool params and SSE — ADR-0002).
- The config **input** type stays unexported. If a config-file loader with truly optional-from-file fields lands (the deferred config-file case), the defaults/optionality modeling deserves a fresh look — but `Value.Default` + `Type.Optional` already cover optional fields, so the library choice is unlikely to need revisiting.
- Provider-prefix validation at boot remains desired (so a typo'd `PIXIES_MODEL=antrophic/...` fails fast with the valid-provider list).

## Alternatives considered

- **Keep Zod for config.** Rejected — maintains a second validation library for a single schema whose input/output split was dead surface area.
- **Use `Value.Convert` for numeric coercion.** Rejected — it silently truncates `"3.5"` → `3`, violating the integer-rejection guarantee. Explicit `Number()` preserves `3.5` so `Type.Integer` rejects it, matching `z.coerce.number().int()`.
- **Wrap defaulted fields in `Type.Optional(...)`.** Rejected — it would make resolved knobs `T | undefined` on the output type, breaking every consumer (`createAgent`, `createOsmClients`, server tests) that treats them as required. Defaults do **not** imply optionality in TypeBox's output type.
- **Drop the schema-level provider check; rely only on `resolveModel`'s guard.** Rejected — loses the boot-time dynamic error message ("Valid providers: …"). Both are kept as defense-in-depth, exactly as before.

## References

- Supersedes the **config portion** of ADR-0002 (`0002-typebox-schemas-in-core.md`); ADR-0002 remains Accepted for tool params + SSE.
- Drop Zod, move config schema to TypeBox.
- Provider-prefix validation (the boot-time error message this preserves).
- Config cleanup: numeric coercion, URL/email formats, empty-as-unset (D3).
- `packages/core/src/config-schema.ts` — `PixiesConfigSchema`, `ResolvedPixiesConfig`.
- `packages/core/src/agent.ts:readConfigFromEnv` — `Value.Default` + `Value.Parse` pipeline, `num()` helper.
