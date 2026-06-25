import type { NominatimResult } from "../clients/nominatim.ts";
import type { GeocodeResultEntry } from "./schemas.ts";

/**
 * Structured, lossless representation of a Nominatim result for UI consumers.
 * The content-side counterpart to `formatNominatimResult` (still owned by the
 * Nominatim client): the pipe string stays the model-facing serialization, this
 * object is the wire contract for structured rendering (issue #15).
 *
 * Owned by the tools layer because it produces a tool result-entry shape
 * (`GeocodeResultEntry`); the client stays pure transport/parse (issue #181).
 */
export function nominatimResultToData(r: NominatimResult): GeocodeResultEntry {
	return {
		placeId: r.place_id,
		lat: Number(r.lat),
		lon: Number(r.lon),
		name: r.name || r.display_name?.split(",")[0] || "unknown",
		...(r.display_name ? { displayName: r.display_name } : {}),
		...(r.class ? { class: r.class } : {}),
		...(r.type ? { type: r.type } : {}),
		...(r.osm_type ? { osmType: r.osm_type } : {}),
		...(r.osm_id !== undefined ? { osmId: r.osm_id } : {}),
	};
}
