# ADR-0007: Self-contained OSM service clients

**Status:** Accepted — 2026-06-25

## Context

Pixies talks to two OpenStreetMap-backed services with different operational and failure semantics:

- **Nominatim** resolves place names and coordinates, defaults to one request per second, and has search/reverse response shapes.
- **Overpass** runs Overpass QL, defaults to two concurrent slots, requires `[out:json]`, and can return a runtime `remark` field that has no Nominatim equivalent.

ADR-0005 introduced a shared `createRateLimiter` wrapper and a shared `osm/` layer (`http.ts`, `format.ts`, `rate-limiter.ts`) to avoid duplicated code while adding Overpass throttling. That layer later became a false category: the shared code mixed service-specific queue defaults, HTTP classification, formatting, and error tags (`OsmBusy`, `OsmHttp`, `OsmParse`, `OsmRemark`) behind an OSM-wide abstraction even though the clients are the actual owners of those behaviours.

The shared `OsmError` union also leaked onto the SSE wire as generic `Osm*` tags. Once clients own their transport and parsing logic, preserving service-agnostic error tags would hide the service that failed and retain a cross-cutting API whose only reason to exist was the old folder structure.

## Decision

Make each OSM service client self-contained under `packages/core/src/clients/`. `NominatimClient` and `OverpassClient` each own their `PQueue`, fetch/busy classification, parse/remark errors, result formatting helpers, and public service-specific error union. Delete the shared `packages/core/src/osm/` layer and replace generic `Osm*` error tags with service-specific tags (`NominatimBusy`, `NominatimHttp`, `NominatimParse`, `OverpassBusy`, `OverpassHttp`, `OverpassParse`, `OverpassRemark`). `ToolAbortedError` remains shared because aborts are a tool/runtime concern, not an OSM-service failure.

## Rationale

1. **Deletion test.** Delete `packages/core/src/osm/`: what breaks should be direct imports only. After moving the small owned pieces into their clients and moving the model-facing busy message to the tools layer, no runtime concept remains that needs an OSM-wide module. A neutral abort utility remains under `utils/` because it is genuinely about abort signals, not OSM.

2. **Per-service ownership matches the domain.** Nominatim and Overpass share that they use HTTP and OpenStreetMap data, but their rate defaults, response schemas, parse failures, and user-facing failure context differ. Client-owned helpers keep those differences visible instead of normalizing them into a weak shared abstraction.

3. **Direct `p-queue` is clearer than a wrapper.** `PQueue` already provides concurrency, interval limits, `strict`, and queued-task abort semantics. Each client now constructs `new PQueue(...)` with its own policy and a tiny local `withRateLimit` wrapper only for Pixies-specific logging/progress semantics.

4. **Error tags should carry useful specificity.** `OverpassRemark` is not a Nominatim failure, and `NominatimBusy` / `OverpassBusy` can be rendered the same by the web UI without erasing the source on the wire. The `PixiesErrorTag` union still gives the web exhaustive copy coverage, but the domain tags now say which service failed.

5. **ADR-0004's invariant is unchanged.** The server still owns one `NominatimClient` and one `OverpassClient` per process and injects them into every agent. One client still means one queue per service, per process. This ADR changes internal ownership and wire tags, not adapter lifetime.

## Consequences

**Positive:**

- `packages/core/src/osm/` is gone; service behaviour lives with the service client that owns it.
- Per-service errors make SSE `errorTag` / `details._tag` more specific while preserving friendly web copy for busy and generic OSM-reach failures.
- Tools still convert service-busy errors into non-error tool results with the same model guidance.
- Queue progress (`queued` / `running`), abort handling, cache behaviour, and server-owned client lifetime are preserved.
- Tool result-entry converters (the `*ToData` mappings into `GeocodeResultEntry` / `OverpassResultEntry`) were relocated to the tools layer (#181), leaving the clients with only the model-facing pipe formatters (`formatNominatimResult` / `formatElement`). Clients now keep only downward dependencies, apart from the `ToolProgress` callback type still tracked by #163.

**Negative:**

- SSE wire tags change from `Osm*` to service-specific `Nominatim*` / `Overpass*` values. Clients that hard-coded old tags need to update.
- Small busy-marker and fetch-classification code is duplicated between the two clients. This is intentional: it avoids rebuilding a shared OSM category for logic whose owner is service-specific.
- ADR-0005 is superseded even though its operational invariant (one client ⇒ one queue) remains true; readers must follow this ADR for the current implementation mechanism.

## Durability

This decision holds while Pixies has a small fixed set of service clients whose failure semantics are better understood independently than through a polymorphic OSM API. Revisit if a real polymorphic caller appears that treats multiple service clients through the same contract; until then, a shared client interface or shared OSM error union is not justified.

If the server becomes multi-process, ADR-0004's durability caveat still applies: queues would need coordination outside the process. That would change queue storage, not the service-owned client/error boundaries recorded here.

## Alternatives considered

- **Keep ADR-0005's shared `createRateLimiter` and only move files.** Rejected — keeps the abstraction that issue #161 explicitly dissolves and preserves an OSM-wide layer whose only remaining purpose would be avoiding a few lines of queue boilerplate.
- **Move clients but keep shared `OsmError` tags.** Rejected — error ownership would still be cross-cutting and would hide whether Nominatim or Overpass failed on the SSE wire.
- **Create new shared `clients/http.ts` or `rate-limit.ts` helpers.** Rejected — this would recreate the false category under a different directory. Only the neutral abort helper moved to `utils/` because it is not OSM-specific.
- **Duplicate `ToolAbortedError` per service.** Rejected — aborts describe user/runtime cancellation across tools and clients, so the existing shared tag remains the right owner.

## References

- Supersedes ADR-0005.
- ADR-0004 — server-owned client lifetime; unchanged by this ADR.
- Issue #161 — self-contained OSM services; dissolve `osm/`.
- Issue #162 — per-service OSM error hierarchies.
- Issue #181 — relocate tool result-entry converters out of the clients, completing this ADR's self-containment.
- `packages/core/src/clients/nominatim.ts` — Nominatim queue, fetch, formatting, and errors.
- `packages/core/src/clients/overpass.ts` — Overpass queue, fetch, formatting, and errors.
- `packages/core/src/tools/geocode-entry.ts` — Nominatim→`GeocodeResultEntry` converter, owned by the tools layer (#181).
- `packages/core/src/tools/busy-message.ts` — model-facing OSM busy guidance owned by tools.
