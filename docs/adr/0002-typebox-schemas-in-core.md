# ADR-0002: TypeBox schemas in core for shared type contracts

**Status:** Accepted — 2026-06-15

## Context

Pixies now has two frontend adapters: `tui` and `web`. Both need to work with structured data that crosses package boundaries — tool parameter definitions (already shared), SSE event payloads (new), and potentially conversation transcripts.

Two approaches for defining shared types:

**A. TypeBox schemas in `@pixies/core`.** Shared schemas with inferred TypeScript types, consumed by all adapters.

**B. Per-package type definitions.** Each adapter defines its own types locally, aligned by convention and documentation.

## Decision

We choose **A: TypeBox schemas in `@pixies/core`.**

SSE event schemas, tool parameter schemas, and any future cross-package type contracts live as TypeBox schema definitions in `@pixies/core`. Adapters import the schemas and use `Value.Check()` for runtime validation and the inferred `Static<T>` types for compile-time safety.

## Rationale

1. **`@pixies/core` already depends on TypeBox.** Tool definitions (`packages/core/src/tools/geocode.ts:6-11`, etc.) use `Type.Object(...)` for parameter schemas. This is not a new dependency — it extends an existing pattern.

2. **Single source of truth.** SSE event shapes (`text_delta`, `tool_execution_start`, etc.) are defined once in `core`, not duplicated across `server` (which emits them) and `web` (which consumes them). When the API spec changes, one file updates.

3. **Runtime validation for free.** The standalone SSE client receives `unknown` JSON from the wire. TypeBox's `Value.Check(schema, data)` validates each frame at runtime, turning parse failures into clear errors instead of downstream `undefined` accesses.

4. **Inferred types flow everywhere.** `Static<typeof TextDeltaEvent>` gives the consumer a compile-time type without hand-written interfaces that can drift from the schema.

5. **Consistency with pi-agent-core.** The upstream `@earendil-works/pi-agent-core` uses TypeBox for tool parameter schemas. Following the same pattern in Pixies core keeps the codebase uniform.

## Consequences

**Positive:**

- Both TUI and web adapters share one set of schemas.
- Runtime validation catches malformed SSE frames at the boundary, not deep in rendering logic.
- Adding a new event type is one change in `core`; both adapters get the type automatically.
- The schemas are JSON Schema under the hood — derivable for documentation or codegen if needed.

**Negative:**

- Core now carries SSE-specific types, which slightly weakens the "interface-independent" boundary from ADR-0001. This is acceptable: the schemas describe the wire format, not transport or lifecycle concerns. Core still does not own conversations, SSE framing, or HTTP handling.

## Alternatives considered

**Per-package type definitions (rejected).** Duplicates type definitions across adapters. The server emits events the web client consumes — hand-syncing two independent type definitions invites drift. No runtime validation unless each adapter also duplicates a validation layer.

**Zod instead of TypeBox (rejected).** Equally capable, but introduces a second validation library alongside the existing TypeBox usage. Inconsistent for marginal benefit.

**No runtime validation (rejected).** The SSE wire is `unknown` JSON. Trusting it without validation means a malformed payload causes a runtime error deep in rendering, not a clear parse error at the boundary.
