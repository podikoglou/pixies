import type { GeocodeResultEntry } from "./schemas.ts";
import type { OverpassResultEntry, StoredElement } from "./schemas.ts";
import type { OverpassElement } from "../clients/overpass.ts";
import { getElementCoords } from "../clients/overpass.ts";

// Re-export the canonical type so existing import sites (`./stored-element`)
// keep working after the type moved to schemas.ts as the single source of
// truth (issue #244, review H2).
export type { StoredElement };

/**
 * Convert a raw {@link OverpassElement} (the client response shape) into the
 * structured wire-entry form tools emit on `details.data`. Shared by
 * `query_osm` and `find_features` so the two stay byte-identical — the
 * alternative was two copies that silently drift.
 *
 * `name` is hoisted out of `tags` (mirroring the model-facing pipe format
 * `formatElement` produces) so each piece of information appears once in
 * the rendered tree.
 */
export function overpassElementToResultEntry(el: OverpassElement): OverpassResultEntry {
	const coord = getElementCoords(el);
	const otherTags: Record<string, string> = {};
	if (el.tags) {
		for (const [k, v] of Object.entries(el.tags)) {
			if (k !== "name") otherTags[k] = v;
		}
	}
	return {
		type: el.type,
		id: el.id,
		...(coord ? { lat: coord.lat, lon: coord.lon } : {}),
		...(el.tags?.name ? { name: el.tags.name } : {}),
		...(Object.keys(otherTags).length > 0 ? { tags: otherTags } : {}),
		...(el.geometry && el.geometry.length > 0 ? { geometryPoints: el.geometry.length } : {}),
	};
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
export function computeBounds(elements: StoredElement[]): Bounds | null {
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
