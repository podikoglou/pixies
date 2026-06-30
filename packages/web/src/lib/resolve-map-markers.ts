import type { DisplayData } from "@pixies/core";

export interface MapMarker {
	lat: number;
	lon: number;
	label?: string;
}

/** A pair of markers connected by a polyline (for spatial_join display). */
export interface MapPolyline {
	from: MapMarker;
	to: MapMarker;
}

type Bounds = { minlat: number; minlon: number; maxlat: number; maxlon: number };

function featureToMarker(feature: { lat?: number; lon?: number; name?: string }): MapMarker | null {
	if (feature.lat === undefined || feature.lon === undefined) return null;
	return { lat: feature.lat, lon: feature.lon, ...(feature.name ? { label: feature.name } : {}) };
}

/**
 * Flatten every display in an `execute_code` result into a flat marker list.
 * Markers come from three sources, in order: explicit `markers`, `features`
 * (those with coordinates), and `pairs` (both point and target, deduped by id
 * within each display so a reused target renders once).
 */
export function displaysToMarkers(displays: DisplayData[]): MapMarker[] {
	const markers: MapMarker[] = [];
	for (const display of displays) {
		if (display.markers) {
			for (const m of display.markers) {
				markers.push({ lat: m.lat, lon: m.lon, ...(m.label ? { label: m.label } : {}) });
			}
		}
		if (display.features) {
			for (const feature of display.features) {
				const marker = featureToMarker(feature);
				if (marker) markers.push(marker);
			}
		}
		if (display.pairs) {
			const seen = new Set<string>();
			for (const pair of display.pairs) {
				for (const feature of [pair.point, pair.target]) {
					const marker = featureToMarker(feature);
					if (!marker) continue;
					if (feature.id) {
						if (seen.has(feature.id)) continue;
						seen.add(feature.id);
					}
					markers.push(marker);
				}
			}
		}
	}
	return markers;
}

/** Extract one polyline per `pairs` entry across all displays. */
export function displaysToPolylines(displays: DisplayData[]): MapPolyline[] {
	const polylines: MapPolyline[] = [];
	for (const display of displays) {
		if (!display.pairs) continue;
		for (const pair of display.pairs) {
			const from = featureToMarker(pair.point);
			const to = featureToMarker(pair.target);
			if (!from || !to) continue;
			polylines.push({ from, to });
		}
	}
	return polylines;
}

/** Return the first bounds carried by any display, or `null` when none. */
export function displaysToBounds(displays: DisplayData[]): Bounds | null {
	for (const display of displays) {
		if (display.bounds) return display.bounds;
	}
	return null;
}
