# ADR-0013: Dependency-resolved tool execution via a per-turn coordinator inside `execute`

**Status:** Experimental — 2026-06-28. Issue #244. May be reverted; the
implementation lives behind an `experiment/` branch until validated.

## Context

Issue #244 introduces a dependency-resolved tool batch: the model emits an
entire multi-step spatial workflow as tool calls in a single assistant turn,
with later calls referencing earlier calls' IDs via `queryRef` /
`pointsRef` / `targetsRef` / `area.queryRef`. The agent resolves the
execution order so dependent calls run after their refs, and independent
calls run in parallel.

This requires the tool dispatch to honour a dependency graph instead of
running the batch as an unordered `Promise.all`.

The framework Pixies builds on — `@earendil-works/pi-agent-core` — dispatches
every tool call in an assistant turn itself, in parallel by default. There
is **no pluggable execution strategy.** The only customisation hooks the
framework exposes are:

- `beforeToolCall` — can block a tool from running, but cannot reorder or
  batch with dependencies.
- `afterToolCall` — can mutate a tool's result, but cannot influence what
  runs when.
- Per-tool `executionMode: "sequential" | "parallel"` — forces the whole
  batch to run sequentially when any tool opts in. Does not express a graph.

So the spec's literal description (modify the turn loop to topologically
sort and execute wave by wave) cannot be implemented without forking the
framework.

## Decision

The dependency graph lives **inside each ref-aware tool's `execute`**, not
in a rewritten turn loop. A per-conversation `TurnCoordinator` (in
`packages/core/src/tools/dependency-graph.ts`) is the rendezvous point:

1. A ref-aware tool's `execute` calls `coordinator.register(toolCallId)`
   synchronously on entry. This adds the ID to the coordinator's in-flight
   set before any `await` resolves (JS runs the synchronous prefix of each
   `execute` in source order before the first microtask settles, so every
   sibling is registered before any tool starts awaiting).
2. The tool then resolves its refs via `resolveRef(ctx, toolCallId, refId,
   signal)`. `resolveRef` checks the result store first (cross-turn refs);
   if absent, it awaits the upstream's in-flight promise via
   `coordinator.awaitResult(refId, dependentId, signal)`.
3. After its real work, the tool calls the `done(result | null)` callback
   the coordinator returned from `register`. `done` resolves every
   dependent's `awaitResult` promise (or rejects with `UpstreamFailedError`
   when called with `null`).
4. The framework still dispatches all the calls in parallel via
   `Promise.all`. The dependency order is emergent: a tool whose `execute`
   awaits a ref simply doesn't make progress until that ref resolves.

Cycle detection is lazy. Before adding a wait edge `dependent → waitee`,
the coordinator DFS-walks `waitingFor` from `waitee` to see if it reaches
`dependent`; if so, the wait is rejected with `CircularRefError`. No
deadlock is possible.

Abort propagation: each `awaitResult` races the upstream promise against
the agent-level `AbortSignal`, so an aborted turn wakes every waiter
rather than hanging on an upstream that was also aborted mid-flight.

The legacy tools (`geocode`, `reverse_geocode`, `query_osm`) are
unchanged and do not participate. The new tools (`find_features`,
`filter`, `spatial_join`) plus `display_map` participate.
`display_map`'s registration is the load-bearing piece for intra-turn
ordering: it lets `display_map(pairsRef: <spatial_join_id>)` wait for
the spatial_join to land in the client's timeline before itself
completing, so the client's ref resolution does not race.

## Consequences

**Positive.**

- No framework fork. The experiment lives entirely in `@pixies/core` and
  degrades gracefully if reverted.
- The coordinator is per-conversation (constructed in `createAgent`,
  injected via tool context), so conversations do not interfere.

**Negative.**

- The dependency contract is implicit, not type-enforced. A tool author
  who forgets `coordinator.register` will see refs to that tool resolve
  as `UnknownRefError` (graceful, but a footgun).
- "Waves" are not visible to the framework, so the agent loop emits
  `tool_execution_start` for every tool up front (in source order),
  even for tools that will quiesce awaiting a ref. The UI shows them as
  "running" before they truly are; a future `execution_plan` SSE event
  would close the gap.
- **Mixing `executionMode: "sequential"` tools with ref-aware tools in
  the same batch breaks ref resolution.** `geocode` and `reverse_geocode`
  are `sequential` (Nominatim's 1 req/s policy). The framework forces the
  *whole batch* sequential when any tool opts in; in that mode, by the
  time tool B's `execute` is called, tool A may already have settled and
  been cleaned up via `queueMicrotask`, so B's `awaitResult(A)` throws
  `UnknownRefError`. The system prompt does not currently forbid this
  mix; the failure mode is a tool error the model can recover from next
  turn, but it's not graceful. A future revision should either extend
  the coordinator to survive cross-mode batches, or harden the system
  prompt against emitting `geocode` and a ref-aware tool in the same
  assistant turn.
- **The system prompt change is NOT backward-compatible for simple
  queries.** The new prompt says "Prefer `find_features` over
  `query_osm`", which redirects every data-fetch query through the new
  tool. `find_features`'s type/brand dictionary has different recall
  characteristics than raw `query_osm`: unknown types fall back to a
  name iregex that may match more or less than the model expects. The
  experiment is structured to surface exactly this regression — if
  simple-query accuracy drops, the prompt paragraph is reverted and
  `find_features` becomes opt-in (only when the query decomposes). No
  automated eval pins the simple-query baseline; the experiment relies
  on dogfooding against the showcase queries plus ad-hoc simple-query
  checks before merge.
- The framework's "synchronous prefix of every `execute` runs in source
  order before any await settles" assumption is load-bearing and
  version-pinned to `@earendil-works/pi-agent-core` 0.79.3. A future
  framework version that interleaves dispatch differently would silently
  break intra-turn ref resolution.

## Alternatives considered

**Fork `pi-agent-core` to add a pluggable execution strategy.** Rejected
for an experiment — the maintenance cost of a fork outweighs the benefit
when the same semantics can be expressed at the tools layer.

**Use `beforeToolCall` to gate dispatch.** Rejected — `beforeToolCall`
runs per tool, after `tool_execution_start` is already emitted, and can
only block. It cannot express "wait for sibling X to finish" — there's
no shared state the hook can await that the framework would honour.

**Extend every legacy tool to participate (query_osm, geocode).**
Rejected for scope — the legacy tools' results aren't `StoredElement`-
shaped (raw Overpass JSON, Nominatim result). The dependency layer is
additive over them; they keep working as the documented escape hatch.
