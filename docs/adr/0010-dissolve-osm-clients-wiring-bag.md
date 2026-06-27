# ADR-0010: Dissolve the OSM-clients wiring bag

**Status:** Accepted — 2026-06-27

## Context

ADR-0007 dissolved the shared `packages/core/src/osm/` layer and the generic `OsmError` union, making each OSM service client self-contained. Three vestiges of that same "OSM" false category survived one layer up, at the wiring layer that sits above the clients:

- The `OsmClients` interface — a `{ nominatim, overpass }` bag (`tools/tool-module.ts`).
- `createOsmClients()` / `CreateOsmClientsOptions` — a factory that constructs both clients behind one options object (`agent.ts`), established as the shared factory by ADR-0004 and projected verbatim at two call sites (`createAgent`'s fallback, and the `ConversationStore` server-owned singleton).
- `OSM_SERVER_BUSY_MESSAGE` — one model-facing string returned by every OSM-backed tool when its service is busy (`tools/busy-message.ts`).

Nominatim and Overpass are unrelated services that happen to serve OpenStreetMap data: different operators, rate policies, response shapes, and failure modes. The bag existed only to group them; its sole consumer (`createTools`) immediately projected it back into per-tool context (`{ nominatim }`, `{ overpass }`). The shared busy string additionally hid which service failed, so the model could not tell the user whether Nominatim or Overpass was down.

## Decision

Wire each service on its own terms, completing what ADR-0007 started one layer up:

- `createTools(nominatim, overpass)` takes the two clients as positional parameters; the `OsmClients` bag is deleted.
- `CreateAgentOptions` takes `nominatim?: NominatimClient` and `overpass?: OverpassClient`, replacing `osmClients?: OsmClients`.
- `createNominatimClient(config, opts)` and `createOverpassClient(config, opts)` — per-service, config-driven factories — replace `createOsmClients`. Both construction sites (the `createAgent` fallback and the `ConversationStore` singleton) call them, so the config → client projection lives once per service.
- `OSM_SERVER_BUSY_MESSAGE` is split into `NOMINATIM_BUSY_MESSAGE` and `OVERPASS_BUSY_MESSAGE`; the system prompt maps each tool to its backing service so the model can name the one that failed.

## Rationale

1. **Deletion test.** Delete `OsmClients` and `createOsmClients`: what breaks is direct references only, and each is mechanical to rewrite. `createTools` was the bag's only consumer and already projected it into per-tool context, so the bag was pure ceremony. Nothing runtime breaks that each client does not already own.

2. **Per-service ownership matches the domain.** The two services share HTTP and OpenStreetMap data and nothing else. A wiring concept that exists only to pair them is the same false category ADR-0007 removed for the `osm/` folder and the error union — just one layer up.

3. **One projection per service closes the two-site drift risk.** The config → client field projection was previously written twice (the agent fallback and the server singleton), differing only in `logger`. That is exactly "repeated object shape with construction ceremony → extract a constructor," and there are two sibling shapes (Nominatim, Overpass), so both get a factory. Adding an OSM knob is now a one-site change per service with no silent drift.

4. **Honesty in failure.** A Nominatim outage is not an Overpass outage. Splitting the busy message and mapping tools to their backing service in the prompt lets the model tell the user which one is down instead of collapsing both into "OSM."

5. **ADR-0004's invariant is unchanged.** The server still constructs one `NominatimClient` and one `OverpassClient` per process and injects them into every agent. One client ⇒ one queue ⇒ one rate-limit chain, per service, per process. This ADR changes the wiring shape, not adapter lifetime.

## Consequences

**Positive:**

- `OsmClients`, `createOsmClients`, `CreateOsmClientsOptions`, and `OSM_SERVER_BUSY_MESSAGE` are gone; each service is wired, named, and owned on its own.
- The config → client projection lives once per service; the two-site drift risk is closed.
- Model guidance can distinguish a Nominatim outage from an Overpass outage.

**Negative:**

- Public `@pixies/core` exports are removed; any external consumer of `createOsmClients` / `OsmClients` / `OSM_SERVER_BUSY_MESSAGE` must migrate to the per-service factories/constants. (Within this monorepo only `@pixies/server` consumed them.)
- Two factory functions replace one. This is intentional: each owns a single service's projection and the grouping was the thing being dissolved.

## Durability

This decision holds while Nominatim and Overpass remain the only two backing services and no polymorphic caller treats them through a shared contract — the same durability bar as ADR-0007. Revisit if a third OSM-backed service arrives whose wiring genuinely shares a shape, or if a real polymorphic caller appears; until then, a shared client interface or shared wiring bag is not justified.

## Alternatives considered

- **Keep the bag; dedup the two call sites with a `createOsmClientsFromConfig`.** Rejected — it preserves the false category this ADR dissolves and leaves the shared busy string hiding the failed service. The per-service factories deliver the same single-site-projection benefit without the bag.
- **Dissolve the bag but inline `new NominatimClient({...})` at both call sites.** Rejected — it recreates the exact two-site drift the factories exist to prevent.
- **One neutral shared busy message, renamed away from "OSM".** Rejected — a single copy still cannot name the failed service, forfeiting the honesty benefit, and leaves a cross-cutting constant whose only purpose is pairing the two services.
- **Put the per-service factories in the client files (`clients/nominatim.ts`).** Rejected — the clients are deliberately config-agnostic (they depend on their own `NominatimConfig` / `OverpassConfig`, not on `ResolvedPixiesConfig`). The factories bridge config → client and belong in the wiring layer (`agent.ts`) so the clients stay reusable, downward-only building blocks.

## References

- Completes ADR-0007 (same false-category smell, one layer up).
- ADR-0004 — server-owned client lifetime; invariant unchanged, only the wiring shape changes.
- ADR-0005 — superseded mechanism (shared rate limiter); its operational invariant survives.
- `packages/core/src/agent.ts` — `createNominatimClient`, `createOverpassClient`, `createAgent`.
- `packages/core/src/tools/index.ts` — `createTools(nominatim, overpass)`.
- `packages/core/src/tools/busy-message.ts` — per-service busy constants.
- `packages/server/src/conversations.ts` — two independent client fields.
