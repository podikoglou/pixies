# Error taxonomy

Expected failures are `TaggedError` subclasses (from `better-result`) carrying
a PascalCase `_tag` discriminant that callers match exhaustively. Shared app
and tool errors live in `packages/core/src/errors.ts`; OSM-service errors live
with their clients and are re-exported from `@pixies/core`.

## The wire invariant

Only the `_tag` crosses the wire on a stream error — **never the `TaggedError`'s
`.message`**. OSM errors embed the searched place name in `.message`, so shipping
it would leak the user's location data; the client maps a received `_tag` to
toast copy. (The `message` field an `error` event *does* carry is a generic
provider-failure string, never a tag's `.message`.)

## How an error reaches the client

| Surface | When | Carries |
|---|---|---|
| HTTP response (pre-stream) | the prompt is rejected before streaming begins | status + `{ error }` body (`ConversationNotFound`→404, `PromptConflict`→409, `BudgetExceeded`→403) |
| SSE `error` event (mid-stream) | an error throws during the agent stream | `{ message, errorTag?, details? }` — `message` is a generic provider string (never a tag's `.message`); `errorTag` is the `_tag` when the error is a `TaggedError` |
| Tool result (`tool_execution_end`, `isError: true`) | an error thrown inside a tool that the framework captures | the agent continues to the next turn |

## The tag schema is the source of truth

`PixiesErrorTagSchema` (`packages/core/src/errors.ts`) is the closed TypeBox
union of every `_tag` literal — **read it for the authoritative catalog, not
this file.** A doc table would only mirror it unguarded, so there isn't one.
Two mechanisms keep the system honest:

- The web client parses the raw `errorTag` string off the wire through this
  schema (TypeBox `Value.Check` at the read boundary), so an unknown tag
  becomes `undefined` rather than being `as`-cast.
- A compile-time guard (`_errorTagSchemaInSync`) fails typecheck if the schema
  and the `TaggedError` classes drift.

User-facing copy for each tag lives in `packages/web/src/lib/error-copy.ts`;
its switch is exhaustive, so adding a `TaggedError` forces a copy arm.

## Adding an error

1. Add a `TaggedError("YourTag")` subclass (in `errors.ts`, or with its client).
2. Add it to the relevant union (`PixiesError`, or a service's `*Error` union).
3. Add `Type.Literal("YourTag")` to `PixiesErrorTagSchema` — the compile-time
   guard flags the drift if you forget.
4. Add user-facing copy for the new tag — the web client's copy switch is
   exhaustive, so adding a tag forces a copy arm.
