# ADR-0004: Server-owned OSM clients (process-global Nominatim rate limit)

**Status:** Accepted — 2026-06-15

## Context

Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) caps requests at **1 per second per source IP** (interpreted in code as `RATE_LIMIT_MS = 1100` to stay safely under the limit). The cap is per IP, not per client instance and not per conversation.

`NominatimClient` enforces this with an internal promise-chain mutex (`withRateLimit`, `packages/core/src/osm/nominatim.ts`). Pre-refactor that mutex lived at module scope, so it serialized *all* calls in the process — correct for the server by accident, surprising for the TUI. Commit `76d6094` ("Move rate-limit state off module scope into `NominatimClient` instance") moved the mutex and `lastCallTime` onto the instance to fix the TUI's hidden-global complaint — and in doing so dropped the cross-conversation serializer with nothing in its place. The note requiring that semantics be preserved lived in a closed issue and was effectively invisible.

The consequence: `createAgent()` news a `NominatimClient` on every call, and `ConversationStore.create()` calls `createAgent()` per conversation. So **N concurrent conversations ⇒ N independent rate-limit chains ⇒ up to N parallel Nominatim requests from one server IP within 1.1s**. That is a usage-policy violation under load, not a theoretical inefficiency. This is a P0 regression.

## Decision

**OSM client ownership moves to the adapter.** `createAgent()` accepts an optional pre-built `osmClients: OsmClients`. When omitted, it constructs clients internally (the path used by the single-user TUI and by tests). When provided, the caller owns the clients' lifetime.

The server adapter — specifically `ConversationStore` — constructs a **single** `OsmClients` pair in its constructor and injects that same instance into every `createAgent()` call. Therefore exactly one `NominatimClient`, and one rate-limit chain, exists per server process regardless of conversation count.

`createOsmClients()` stays in core as the shared factory; *who calls it* changes (adapter, not `createAgent`).

This refines ADR-0001's seam: ADR-0001 says "core exposes `createAgent()` plus the system prompt, tools, and OSM clients." That remains true — core still constructs clients for adapters that want it to. This ADR records that **multi-tenant adapters MUST inject their own shared instance** rather than letting `createAgent` build a fresh one per call.

## Rationale

1. **Per-instance scoping is wrong for multi-tenant adapters.** The rate limit is per source IP. The server has one source IP shared by all conversations, so the serializer must be shared by all conversations. A per-instance mutex under-counts by a factor of N (= conversation count). The TUI, being single-user with one Agent per process, was never affected by either scoping.

2. **Locality.** Client lifetime is a runtime concern; the only adapter that cares about lifetime is the server. Pushing ownership to the server keeps `createAgent` a pure wiring function over inputs it does not own, and concentrates all lifetime reasoning in the adapter that already owns conversation TTL, sweeping, and process lifecycle. This matches ADR-0001's principle that adapters own their runtime.

3. **Cleanest seam, least coupling.** Three options were on the table:
   - **(a) Server-owned clients injected into `createAgent`** *(chosen)*. One optional parameter. The factory and the client classes are untouched. The TUI path is unchanged. Inversion is localized to one call site per adapter.
   - **(b) Process-global client singleton in core.** Restores the module-global `chain`/`lastCallTime` that the TUI objected to, just dressed up. Re-introduces the hidden global the refactor was trying to remove; the TUI inherits a singleton it never asked for.
   - **(c) Shared mutex behind the client, decoupled from instance.** Keeps per-instance clients but routes the rate-limit chain through an injected shared token. Works, but couples `NominatimClient` to a new abstraction (the token) and obscures the real invariant ("one client per process") behind a wrapper. More machinery for the same outcome.

   Option (a) makes the invariant literally structural — *one instance* — rather than emergent from shared mutable state. The thing you can see in the source (`osmClients` stored once on `ConversationStore`) is the thing that is true at runtime.

4. **Testability lever.** With clients injectable, `NominatimClient` is now exercisable in isolation with a fake `fetch`, and the regression itself becomes assertable: "two agents built from the same injected client serialize their Nominatim calls to ≤ 1 / 1.1s." That property regressed and currently has zero coverage.

## Consequences

**Positive:**

- The Nominatim per-IP policy is honored by design: one client ⇒ one chain ⇒ ≤ 1 req / 1.1s per process, independent of conversation count.
- `createAgent` is a pure wiring function over its inputs; no hidden construction.
- OSM clients are now injectable everywhere (server, tests), unblocking fake-`fetch` tests.
- The TUI path is unchanged — it still calls `createAgent({ config })` and gets internally-built clients.

**Negative:**

- A maintainer reading only ADR-0001 might assume `createAgent` always builds the clients and re-introduce per-instance scoping (the exact regression this ADR exists to prevent). This ADR and the docstring on `CreateAgentOptions.osmClients` are the guardrails.
- The invariant is enforced by convention, not by the type system. A future adapter that calls `createAgent({ config })` without injecting clients would silently get a per-instance client. Mitigation: the multi-tenant adapter is currently unique (the server), and its single call site is now explicit.

## Durability

This decision is durable for as long as:

- Nominatim's usage policy remains per-IP (it has for the project's lifetime and reflects the service's fundamental capacity model).
- The server is a single process coordinating conversations in memory (ADR-0001, confirmed out of scope: cross-process coordination would need a shared backend like Redis and is explicitly deferred).

If the server ever becomes multi-process, this ADR's *constraint* (one chain per source IP) still holds; only its *mechanism* would change (the shared token would need to live outside the process). That future is covered by option (c) above and is explicitly out of scope here.

## Alternatives considered

**Process-global client singleton in core (b).** Rejected — re-introduces the hidden global the `76d6094` refactor removed; couples the TUI to a singleton; conflicts with ADR-0001's "adapters own their runtime."

**Shared-rate-limit-token behind `NominatimClient` (c).** Rejected — adds an abstraction to encode an invariant that "one client per process" already expresses structurally.

**Revert `76d6094` (restore module-scoped mutex).** Rejected — would re-break the TUI property (hidden global, surprising for single-user adapters) and is the opposite of ADR-0001's direction.

## References

- ADR-0001 — interface-independent core; this ADR refines its seam.
- ADR-0005 — the bespoke Nominatim mutex is now a shared `p-queue` rate limiter; the invariant here (one client ⇒ one queue ⇒ one chain) is unchanged.
- `packages/core/src/osm/nominatim.ts` — `createRateLimiter`-backed throttle.
- `packages/core/src/agent.ts` — `createAgent({ osmClients })`, `createOsmClients`.
- `packages/server/src/conversations.ts` — single `OsmClients` per `ConversationStore`.
- `docs/api/sse.md` — Concurrency section describes the implemented invariant.
- Flagged the module-global mutex as a hidden global; this ADR preserves its *multi-tenant* requirement explicitly.
- This regression and its framing.

## Revision — 2026-06-25

ADR-0007 (self-contained OSM service clients) moved code referenced above
without changing this ADR's invariant. The Context, Decision, Rationale, and
Consequences text is left as written at acceptance; this section records the
pointer/mechanism update only.

- `packages/core/src/osm/nominatim.ts` → `packages/core/src/clients/nominatim.ts`.
- The shared `createRateLimiter` (ADR-0005, now superseded) was replaced by a
  direct per-client `p-queue`. The Nominatim client still owns one queue, so
  "one client ⇒ one queue ⇒ one chain" still holds.
- Forward reference ADR-0005 → ADR-0007.
