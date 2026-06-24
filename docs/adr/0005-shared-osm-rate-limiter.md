# ADR-0005: Shared p-queue rate limiter for OSM clients

**Status:** Superseded by ADR-0007 — 2026-06-25

## Context

Both OSM services the agent calls enforce per-IP usage policies:

- **Nominatim** caps at 1 request/second per source IP (interpreted as 1100ms to stay safely under the limit).
- **Overpass** grants 2 concurrent slots per IP (`GET /api/status` reports "Rate limit: 2").

Before this ADR, the two clients throttled themselves with **different, non-reusable mechanisms**:

- `NominatimClient` carried a bespoke serial promise-chain (`withRateLimit`, `chain`, `lastCallTime`, `RATE_LIMIT_MS`) living inside the class.
- `OverpassClient` had **no throttle at all** — `query()` called `osmFetch()` directly, so concurrent conversations could fire unbounded parallel Overpass queries from the server's IP.

The bespoke Nominatim mutex worked but couldn't be shared with Overpass, and the Overpass gap was an unaddressed policy risk. ADR-0004 had already established the structural invariant that matters here — one client instance per process (owned by `ConversationStore`) ⇒ one throttle ⇒ process-global per-IP serialization. What was missing was a single reusable throttle primitive wired into both clients.

## Decision

Introduce one shared throttle primitive — `createRateLimiter({ concurrency, intervalCap, interval, strict })` in `packages/core/src/osm/rate-limiter.ts` — backed by **`p-queue`**. It returns `{ withRateLimit, queue }`, where `withRateLimit(fn, signal?, callbacks?)` mirrors the shape Nominatim's old method exposed (including `RateLimitCallbacks` `queued`/`running` progress reporting).

Both clients construct their own limiter at their per-service policy:

| Client | Limiter config (defaults) | Grounding |
| --- | --- | --- |
| Nominatim | `{concurrency:1, intervalCap:1, interval:1100ms, strict:true}` | 1 req/s per-IP policy of the default public `nominatim.openstreetmap.org`; `strict` sliding window prevents boundary bursts. |
| Overpass | `{concurrency:2, intervalCap:2, interval:1000ms}` | `/api/status` "Rate limit: 2" on the default public `overpass-api.de`; concurrency is the hard policy (Overpass queries are slow, so fixed-window bursts are not a real risk). |

Each value is a per-instance config knob (`NominatimConfig`/`OverpassConfig` `concurrency`/`intervalCap`/`intervalMs`) whose defaults reproduce today's behavior. `strict:true` is an internal Nominatim default (not env-exposed). The defaults target the **public** instances; self-hosted/custom instances are configurable via the env vars below.

The old Nominatim `chain`/`lastCallTime`/`RATE_LIMIT_MS`/`withRateLimit` are deleted; `fetchJson` now calls `this.limiter.withRateLimit(...)`. Overpass `query()` wraps its `osmFetch` in `this.limiter.withRateLimit(...)` and gains an optional `callbacks` param so `query_osm` can report `queued`/`running` progress like the Nominatim tools.

**Per-instance policy is now env-configurable.** The three limiter knobs per service are exposed as six env-backed `PixiesConfigSchema` fields (read in `readConfigFromEnv` and plumbed through `CreateOsmClientsOptions` → `createOsmClients`):

| Service | Env vars | Defaults |
| --- | --- | --- |
| Nominatim | `PIXIES_NOMINATIM_CONCURRENCY` / `PIXIES_NOMINATIM_INTERVAL_CAP` / `PIXIES_NOMINATIM_INTERVAL_MS` | 1 / 1 / 1100 |
| Overpass | `PIXIES_OVERPASS_CONCURRENCY` / `PIXIES_OVERPASS_INTERVAL_CAP` / `PIXIES_OVERPASS_INTERVAL_MS` | 2 / 2 / 1000 |

The defaults equal the public-instance policies above; operators pointing at self-hosted mirrors via `PIXIES_NOMINATIM_URL`/`PIXIES_OVERPASS_URL` can raise them to match that mirror's own limits.

ADR-0004's invariant is **preserved structurally**: `createOsmClients` still builds one `NominatimClient` + one `OverpassClient`, and `ConversationStore` still calls `createOsmClients` **once**. One instance ⇒ one p-queue ⇒ one chain, per service, per process — independent of conversation count.

## Rationale

1. **One primitive, two policies.** p-queue models rate (`intervalCap`/`interval`) and concurrency independently, plus a `strict` sliding window for Nominatim's burst-sensitive policy. Both services' needs are expressed as config to the same factory instead of two bespoke implementations.

2. **Native abort semantics (CAVEAT #1).** `queue.add(fn, { signal })` removes a queued task and rejects its promise when the signal aborts — the task never runs. The limiter normalizes that rejection to `signal.reason ?? new Error("Aborted")` to preserve the exact shape Nominatim historically emitted. A running task's abort is threaded into `osmFetch({ signal })` exactly as before.

3. **Errors pass through untouched (CAVEAT #3).** The limiter re-throws the task's rejection unchanged unless `signal?.aborted`; `OsmServerBusyError` and `osmFetch` errors surface identically to the prior implementation.

4. **ADR-0004 unchanged, now testable.** Moving the mutex behind a shared factory added no new ownership seam. ADR-0004's "one client per process" remains the literal source-level invariant; the per-client serialization it requires is now covered by `nominatim.test.ts` and `overpass.test.ts` (the ADR-0004 property previously had zero direct coverage).

5. **Progress parity.** `query_osm` now emits `queued`/`running` updates like `geocode`/`reverse_geocode`, improving UX for Overpass's 10–60s queries.

## Consequences

**Positive:**

- Overpass is now throttled to 2 concurrent slots (was unbounded).
- One well-tested throttle primitive replaces two mechanisms; future OSM services reuse it by config.
- Both clients have direct unit coverage (serialization, abort, busy passthrough).
- The limiter knobs are now env-configurable per instance (`PIXIES_NOMINATIM_*` / `PIXIES_OVERPASS_*`), promoting the old module constant `RATE_LIMIT_MS` to three knobs per service. Defaults reproduce today's behavior; self-hosted mirrors and fast tests can override them.

**Negative:**

- New runtime dependency `p-queue@^9.3.0` in `@pixies/core` (ESM, Bun-compatible; lockfile committed).
- *Accepted progress divergence:* the limiter emits `{type:"queued"}` only when all concurrency slots are occupied at enqueue time. A task that waits purely on an interval slot (concurrency free, but rate-limited) does **not** emit `queued`. This only affects the single-user interval-only case; the multi-tenant contention case (ADR-0004) always has a slot occupied and emits correctly. Documented in `rate-limiter.ts`; no behavior previously asserted this.

## Durability

This decision holds for as long as:

- The **default public `nominatim.openstreetmap.org`** usage policy remains per-IP 1 req/s — the built-in defaults (`concurrency:1, intervalCap:1, interval:1100ms, strict`) are tuned to it (ADR-0004 durability applies). Self-hosted/custom Nominatim mirrors (`PIXIES_NOMINATIM_URL`) have their own limits, now configurable via `PIXIES_NOMINATIM_CONCURRENCY` / `PIXIES_NOMINATIM_INTERVAL_CAP` / `PIXIES_NOMINATIM_INTERVAL_MS`.
- The **default public `overpass-api.de`** 2-slot policy holds (verified against `/api/status`) — the built-in defaults (`concurrency:2, intervalCap:2, interval:1000ms`) match it. Self-hosted/custom Overpass instances (`PIXIES_OVERPASS_URL`) have their own limits, now configurable via `PIXIES_OVERPASS_CONCURRENCY` / `PIXIES_OVERPASS_INTERVAL_CAP` / `PIXIES_OVERPASS_INTERVAL_MS`.
- The server is a single process (ADR-0001); a multi-process future would need the throttle to live outside the process — the same caveat ADR-0004 records.

## Alternatives considered

- **Keep the bespoke Nominatim mutex; add a separate Overpass throttle.** Rejected — duplicates throttle logic and loses a single tested primitive.
- **Process-global p-queue singleton in core.** Rejected (ADR-0004 option b) — re-introduces a hidden global that conflicts with ADR-0001's "adapters own their runtime"; the per-instance approach already encodes the invariant structurally.
- **Caddy-side API rate limiting instead of in-process.** Out of scope for the OSM layer (this ADR is about OSM clients). The separate HTTP per-IP limit (issue #91) is in-process for the reasons in `packages/server/src/rate-limit.ts`; Caddy remains an optional future defense-in-depth.

## References

- ADR-0004 — one client ⇒ one queue ⇒ one chain; this ADR changes the mechanism, not the invariant.
- `packages/core/src/osm/rate-limiter.ts` — `createRateLimiter`.
- `packages/core/src/osm/nominatim.ts`, `packages/core/src/osm/overpass.ts` — per-service config.
- [p-queue](https://github.com/sindresorhus/p-queue) — concurrency + interval + strict sliding window.
- Issue #91 — rate limiting (HTTP API + OSM clients).
