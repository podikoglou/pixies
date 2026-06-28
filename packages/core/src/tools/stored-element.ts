/** A latitude/longitude axis-aligned bounding box. */
export interface Bounds {
	minlat: number;
	minlon: number;
	maxlat: number;
	maxlon: number;
}

/**
 * Compute the bounding box of a set of elements with optional lat/lon.
 * Returns `null` when no element carries both coordinates.
 */
export function computeBounds(elements: { lat?: number; lon?: number }[]): Bounds | null {
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
