# ADR-0008: Re-validate Drizzle `$type<>` JSON columns at the read boundary

**Status:** Accepted — 2026-06-25

## Context

`packages/core/src/db/schema.ts` declares the SQLite `transcript` column as:

```ts
transcript: text("transcript", { mode: "json" }).$type<AgentMessage[]>(),
```

Drizzle's `$type<T>()` is a **TypeScript-only** annotation: it tells the ORM that the deserialized JSON should be treated as `AgentMessage[]` at compile time, but it performs **no runtime validation**. The bytes that come back from SQLite are `JSON.parse`d into an untyped value and then exposed to the rest of the program as if they were already `AgentMessage[]` — any shape SQLite happens to hold (a `null`, a string, an object missing `role`, a row written by an older schema version) flows straight into the in-memory agent state with zero checking.

Issue #106 closed the gap for this one column by adding `PersistedTranscriptSchema` / `isPersistedTranscript` (in `packages/core/src/transcript-schema.ts`) and calling it at the `ConversationStore` read boundary (`packages/server/src/conversations.ts`, `rehydrateTranscript`). That fix lives at the read site, not in the schema — which is correct, since `$type<>` is compile-time by design. **But nothing in the codebase records the rule that every `$type<>` JSON column must have such a guard.** A future JSON column added to `schema.ts` with `$type<>` and no read-site check would reintroduce the exact gap #106 closed, silently, because the type system would claim the data is already validated.

This is a cross-cutting storage-boundary rule with long-term consequences (it binds every future schema change), not a one-off fix — so it is recorded as an ADR rather than left as a comment.

## Decision

Any Drizzle column declared as `text({ mode: "json" }).$type<T>()` that crosses a persisted/untrusted boundary (SQLite, any future store) **MUST** be re-validated with a TypeBox `Value.Check` at its read site before its value is trusted. `$type<>` is compile-time only and does not validate persisted JSON.

Concretely, the contract for a `$type<>` JSON column is three pieces:

1. **The column** in `schema.ts` — `text("col", { mode: "json" }).$type<T>()`.
2. **A permissive TypeBox guard** that captures the column's runtime contract. Stored JSON accumulates fields across versions (upstream message shapes, metadata added later), so the guard should be deliberately permissive (`additionalProperties: true`, only the structural keys that define the type — see `PersistedAgentMessageSchema`) — it needs to catch **gross** corruption (non-array, missing/unknown discriminator, wrong primitive), not to pin every field the producer owns.
3. **The read site** — wherever the row is loaded and the column's value is about to be trusted, the guard runs first. On failure: warn-log and degrade gracefully (start empty / drop the field / fall back to a safe default) — never throw, never silently assign the unchecked value.

Each `$type<>` column in `schema.ts` carries a comment naming its guard function and this ADR, so a future schema author cannot add one without seeing the rule.

## Rationale

1. **Deletion test.** Delete `isPersistedTranscript` and the `rehydrateTranscript` guard: what breaks is *nothing at compile time* — `row.transcript` is still typed `AgentMessage[]`, so the assignment compiles, and a corrupted row silently mis-types the agent's in-memory state. The type system actively hides the gap. Only the runtime guard exposes it. A rule that is invisible to the type system and enforced only by convention *must* be written down, or the next column ships without it.

2. **`$type<>` is compile-time by design.** Drizzle documents `$type<>` as a TS-only cast; it is not a contract that persisted data satisfies the type. The validation has to happen somewhere else. The read site is the only place that sees the raw persisted value *and* knows the intended type — storing the guard next to the schema (the type) and calling it at the read site (the boundary) mirrors ADR-0002's "schema in core, `Value.Check` at the boundary" split.

3. **Persisted data is untrusted.** A SQLite file is outside the TS process's invariants: it can be hand-edited, migrated partially, written by an older binary, or corrupted on disk. Treating its contents as already-typed is the same class of mistake as trusting an HTTP body or `JSON.parse` output — both of which ADR-0002 already requires decoding through a schema. The storage boundary is not special.

4. **Permissive guard, not a strict one.** The guard's job is to catch the row that would *mis-type* program state (a non-array, an object with no `role`), not to reject rows that merely have extra fields the local type doesn't name. The persisted producer (pi-ai's `AgentMessage`) owns its field set and may extend it across versions; a strict guard would reject every real production row after any upstream field addition (this is exactly why #106 could not reuse the strict `ConversationTranscriptSchema` — see the audit finding in PR #151). Permissive-structural is the stable contract.

5. **One library, one rule.** After ADR-0006, `@pixies/core` is TypeBox-only — so "re-validate with TypeBox `Value.Check`" is not a new pattern or a second dependency, it is the existing pattern every other boundary in core already uses (SSE events, config, OSM responses). The rule generalizes an established practice to the one boundary that was missing it.

## Consequences

**Positive:**

- A future `$type<>` JSON column added to `schema.ts` cannot be added silently: the comment on the existing column, plus this ADR, plus the `CONVENTIONS.md` pointer, name the obligation.
- The read site — not the schema — remains the place validation happens, preserving Drizzle's compile-time-only `$type<>` semantics and keeping the schema file free of runtime concerns.
- Persisted data is treated as untrusted consistently with HTTP/SSE/config boundaries (ADR-0002), closing the one boundary that was previously trusted on the type system's say-so.
- Corruption degrades gracefully (warn + empty/safe default) rather than throwing or mis-typing state, matching #106's chosen failure handling.

**Negative:**

- Every new `$type<>` JSON column requires a third artifact (the guard) plus a read-site call — more ceremony than adding a plain `text` column. This is the cost of not trusting persisted JSON; it is accepted.
- The guard is permissive by design, so it will not catch a row that is a well-shaped `AgentMessage[]` but has semantically wrong contents (e.g. a field with the right shape but a stale value). That is outside the scope of a structural boundary check.
- The rule is convention, not enforced by the type system or a lint rule. A reviewer must check that a guard exists when a `$type<>` column is added. (A grep-based lint was considered — see Alternatives — and rejected as out of scope for this ADR.)

## Durability

This decision holds for as long as:

- `drizzle-orm` is the persistence layer and `$type<>` remains a TS-only annotation (if Drizzle ever ships a runtime-validating variant, the rule would narrow to "use that").
- TypeBox is the validation library in `@pixies/core` (ADR-0002, ADR-0006). If the storage domain moves off TypeBox, the rule's *obligation* (re-validate at the read boundary) survives; only the named mechanism changes.
- Persisted JSON is produced by an upstream whose field set may extend across versions (justifying the permissive-guard choice). If a column ever stores a fully-owned, closed shape, a strict guard becomes appropriate — but the obligation to have *a* guard is unchanged.

Revisit if Pixies adopts a storage layer with its own decoding step (e.g. a repository abstraction that wraps every read with a schema), at which point the rule would move into that layer instead of living at each call site.

## Alternatives considered

- **Record the rule only in `docs/CONVENTIONS.md`, no ADR.** Rejected as the sole home — the rule has cross-cutting, long-term consequences and directly extends ADR-0002's storage domain, which is exactly what this repo's ADRs are for (see the house style of ADR-0001–0007). `CONVENTIONS.md` is a pointer for contributors; this ADR is the durable record of *why*.

- **A strict guard (pin every field of `AgentMessage`).** Rejected — the persisted producer (pi-ai) owns its message shape and extends it across versions; a strict guard would reject every real production row after any upstream field addition. This is the mistake #106 explicitly avoided (PR #151 audit finding). Permissive-structural is the stable contract.

- **No guard; trust `$type<>`.** Rejected — this is the status quo ante #106, where a corrupted row silently mis-types the agent's in-memory state. The type system actively hides the failure; only a runtime check exposes it.

- **Validate in the schema via a Drizzle custom type instead of at the read site.** Rejected — it would couple the schema file to a specific TypeBox guard and to runtime validation, blurring the schema/boundary split ADR-0002 establishes. The schema declares the intended type; the read site validates the actual bytes. Keeping them separate also lets the failure degrade gracefully (warn + empty) rather than throwing out of the ORM call.

- **A grep-based lint that fails CI when a `$type<>` column lacks a paired guard.** Rejected for this ADR — useful as future hardening, but it presupposes a stable convention for "naming" the guard per column, which we do not have with a single example. Land the convention first; the lint can follow once a second `$type<>` column confirms the naming pattern.

- **Throw on corruption instead of warn + degrade.** Rejected — a corrupted row would crash the conversation load for the user. #106 deliberately chose warn + start fresh (user still gets a working conversation; operator gets a `warn` line). Throwing is reserved for truly invariant violations, not for untrusted persisted data.

## References

- Extends the **storage domain** of ADR-0002 (`0002-typebox-schemas-in-core.md`), which establishes TypeBox + `Value.Check` at boundaries for tool params, SSE events, and (per ADR-0006) config. This ADR adds the Drizzle `$type<>` read boundary to that list.
- ADR-0006 — `@pixies/core` is TypeBox-only (Zod dropped); the "TypeBox `Value.Check`" mechanism in this rule is the existing one, not a new dependency.
- #106 — the manual-parsing-gaps audit that surfaced the gap and closed it for `transcript`.
- #150 — this issue (document the convention).
- PR #151 — closed the `transcript` read-site gap; its "Scope discovery" section filed #150 as the follow-up.
- `packages/core/src/db/schema.ts:6` — the `transcript` column and its pointer comment.
- `packages/core/src/transcript-schema.ts` — `PersistedAgentMessageSchema`, `PersistedTranscriptSchema`, `isPersistedTranscript` (the permissive guard).
- `packages/server/src/conversations.ts:260` — `rehydrateTranscript`, the read-site guard call.
