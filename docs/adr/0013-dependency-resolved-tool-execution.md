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
- Backward-compatible. The framework's dispatch semantics are untouched;
  simple queries behave identically.
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
- The coordinator's `done(null)` contract for upstream failure means
  downstream tools surface `UpstreamFailedError` rather than the
  upstream's specific error tag. The model sees the cause text but not
  the typed tag.

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
