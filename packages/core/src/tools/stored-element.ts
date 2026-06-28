import type { GeocodeResultEntry } from "./schemas.ts";
import type { OverpassResultEntry } from "./schemas.ts";

/**
 * Unified element shape used by the dependency-resolved tool layer
 * (`find_features`, `filter`, `spatial_join`) and the per-conversation
 * {@link ResultStore}. Producers (`find_features`, `geocode`, `filter`)
 * map their tool-specific result shape into this common form; consumers
 * (`filter`, `spatial_join`, `display_map`) operate on it without
 * branching on the source tool.
 *
 * `id` is a stable `"<type>/<numeric>"` string used for deduplication and
 * `elementIds` matching — same scheme the web client already uses for
 * `query_osm` results (`"node/12345"`). Geocode results, which carry no
 * OSM type/id in some cases, fall back to `"place/<placeId>"`.
 */
export interface StoredElement {
	id: string;
	/** OSM element type when present (`"node" | "way" | "relation"`); absent for geocode-only entries. */
	type?: "node" | "way" | "relation";
	lat?: number;
	lon?: number;
	name?: string;
	tags?: Record<string, string>;
}

/**
 * Map an {@link OverpassResultEntry} (the structured form `query_osm` and
 * `find_features` produce) into the canonical {@link StoredElement}.
 *
 * `tags` is preserved as-is; `name` (hoisted out of `tags` by the producers)
 * is re-injected under `tags.name` so filter expressions like
 * `name =~ /stockholm/i` and `tags.population < 30000` both resolve.
 */
export function overpassEntryToStored(el: OverpassResultEntry): StoredElement {
	const tags: Record<string, string> = { ...el.tags };
	if (el.name) tags.name = el.name;
	return {
		id: `${el.type}/${el.id}`,
		type: el.type,
		...(el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : {}),
		...(el.name ? { name: el.name } : {}),
		...(Object.keys(tags).length > 0 ? { tags } : {}),
	};
}

/**
 * Map a {@link GeocodeResultEntry} into the canonical {@link StoredElement}.
 *
 * Geocode results carry no OSM tags; the geocoder's `class`/`type` are
 * projected into `tags` so a downstream `filter` has something to predicate
 * on. `id` falls back to `place/<placeId>` when `osmType`/`osmId` are absent.
 */
export function geocodeEntryToStored(el: GeocodeResultEntry): StoredElement {
	const tags: Record<string, string> = {};
	if (el.class) tags.class = el.class;
	if (el.type) tags.type = el.type;
	if (el.osmType && el.osmId !== undefined) {
		tags.osmType = el.osmType;
		tags.osmId = String(el.osmId);
	}
	if (el.name) tags.name = el.name;
	const id =
		el.osmType && el.osmId !== undefined ? `${el.osmType}/${el.osmId}` : `place/${el.placeId}`;
	return {
		id,
		...(el.osmType ? { type: el.osmType } : {}),
		lat: el.lat,
		lon: el.lon,
		...(el.name ? { name: el.name } : {}),
		tags,
	};
}

/** A latitude/longitude axis-aligned bounding box. */
export interface Bounds {
	minlat: number;
	minlon: number;
	maxlat: number;
	maxlon: number;
}

/**
 * Compute the bounding box of a set of stored elements. Returns `null` when
 * no element carries `lat`/`lon`. Used by `find_features` to resolve an
 * `area.queryRef` to a search bbox and by `display_map` to fit the view.
 */
export function computeBounds(elements: readonly StoredElement[]): Bounds | null {
	let minlat = Number.POSITIVE_INFINITY;
	let minlon = Number.POSITIVE_INFINITY;
	let maxlat = Number.NEGATIVE_INFINITY;
	let maxlon = Number.NEGATIVE_INFINITY;
	let seen = 0;
	for (const el of elements) {
		if (el.lat === undefined || el.lon === undefined) continue;
		seen++;
		if (el.lat < minlat) minlat = el.lat;
		if (el.lat > maxlat) maxlat = el.lat;
		if (el.lon < minlon) minlon = el.lon;
		if (el.lon > maxlon) maxlon = el.lon;
	}
	if (seen === 0) return null;
	return { minlat, minlon, maxlat, maxlon };
}

/**
 * Approximate area of a bbox in km², using the planar approximation at the
 * centroid latitude. Used by Overpass-query validation to reject planet-wide
 * scans. Accurate enough for the safety check; not survey-grade.
 */
export function boundsAreaKm2(b: Bounds): number {
	const heightKm = (b.maxlat - b.minlat) * 111;
	const midLat = (b.maxlat + b.minlat) / 2;
	const widthKm = (b.maxlon - b.minlon) * 111 * Math.cos((midLat * Math.PI) / 180);
	return Math.abs(heightKm * widthKm);
}

/**
 * Expand a bbox outward from its center by `meters` in every direction.
 * Used by `find_features.area.queryRef` to give the upstream result's bounds
 * a small margin so edge-of-area features aren't clipped.
 */
export function expandBounds(b: Bounds, meters: number): Bounds {
	const latDelta = meters / 111_000;
	const midLat = (b.maxlat + b.minlat) / 2;
	const lonDelta = meters / (111_000 * Math.cos((midLat * Math.PI) / 180));
	return {
		minlat: b.minlat - latDelta,
		maxlat: b.maxlat + latDelta,
		minlon: b.minlon - lonDelta,
		maxlon: b.maxlon + lonDelta,
	};
}
