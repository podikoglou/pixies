import type { OverpassResultEntry, StoredElement } from "@pixies/core";
import type { ToolResult } from "@pixies/core";
import type { TimelineItem } from "@/state/chat-reducer";

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

/**
 * Normalise any element-bearing tool result into a list of `{lat, lon, label?}`
 * markers. Returns `null` when the result kind carries no element data
 * (`display_map`, `query_osm` raw payload, `empty`, `find_features_busy`).
 *
 * Centralises the per-kind projection so the resolver and any future
 * consumer share one shape.
 */
function resultToMarkers(result: ToolResult): MapMarker[] | null {
	switch (result.kind) {
		case "query_osm":
		case "find_features":
			return overpassEntriesToMarkers(result.entries);
		case "filter":
			return storedElementsToMarkers(result.entries);
		case "spatial_join":
			return storedElementsToMarkers(result.pairs.flatMap((p) => [p.point, p.target]));
		case "geocode":
			return result.entries.map((e) => ({
				lat: e.lat,
				lon: e.lon,
				...(e.name ? { label: e.name } : {}),
			}));
		case "reverse_geocode":
			return [
				{
					lat: result.entry.lat,
					lon: result.entry.lon,
					...(result.entry.name ? { label: result.entry.name } : {}),
				},
			];
		default:
			return null;
	}
}

/**
 * Extract pairs (point + target) as both markers and polylines from a
 * `spatial_join` result. Returns `null` for any other result kind.
 */
function resultToPairs(
	result: ToolResult,
): { markers: MapMarker[]; polylines: MapPolyline[] } | null {
	if (result.kind !== "spatial_join") return null;
	const markers: MapMarker[] = [];
	const polylines: MapPolyline[] = [];
	const seen = new Set<string>();
	for (const pair of result.pairs) {
		const pm = storedElementToMarker(pair.point);
		const tm = storedElementToMarker(pair.target);
		if (!pm || !tm) continue;
		if (!seen.has(pair.point.id)) {
			seen.add(pair.point.id);
			markers.push(pm);
		}
		if (!seen.has(pair.target.id)) {
			seen.add(pair.target.id);
			markers.push(tm);
		}
		polylines.push({ from: pm, to: tm });
	}
	return { markers, polylines };
}

function overpassEntriesToMarkers(entries: OverpassResultEntry[]): MapMarker[] {
	return entries
		.filter(
			(e): e is OverpassResultEntry & { lat: number; lon: number } =>
				e.lat != null && e.lon != null,
		)
		.map((e) => ({ lat: e.lat, lon: e.lon, ...(e.name ? { label: e.name } : {}) }));
}

function storedElementsToMarkers(entries: StoredElement[]): MapMarker[] {
	const seen = new Set<string>();
	const out: MapMarker[] = [];
	for (const el of entries) {
		if (el.lat === undefined || el.lon === undefined) continue;
		if (seen.has(el.id)) continue;
		seen.add(el.id);
		const m = storedElementToMarker(el);
		if (m) out.push(m);
	}
	return out;
}

function storedElementToMarker(el: StoredElement): MapMarker | null {
	if (el.lat === undefined || el.lon === undefined) return null;
	return { lat: el.lat, lon: el.lon, ...(el.name ? { label: el.name } : {}) };
}

/**
 * Find the tool-call timeline item whose `toolCallId` matches `ref`. Falls
 * back to the nearest preceding element-bearing tool call when the exact ID
 * is missing — small models sometimes mis-transcribe provider-assigned IDs.
 */
function findRelevantItem(
	ref: string,
	items: TimelineItem[],
	currentIndex?: number,
): Extract<TimelineItem, { kind: "tool-call" }> | undefined {
	let item = items.find(
		(it): it is Extract<TimelineItem, { kind: "tool-call" }> =>
			it.kind === "tool-call" && it.toolCallId === ref,
	);
	// Reject items whose result has no element data (e.g. another display_map).
	if (item && resultToMarkers(item.result) === null && resultToPairs(item.result) === null) {
		item = undefined;
	}

	if (!item) {
		const upperBound = currentIndex ?? items.length;
		for (let i = upperBound - 1; i >= 0; i--) {
			const it = items[i];
			if (!it || it.kind !== "tool-call") continue;
			if (resultToMarkers(it.result) === null && resultToPairs(it.result) === null) continue;
			item = it;
			break;
		}
	}
	return item;
}

/**
 * Resolve a `queryRef` / `elementsRef` to a list of markers by walking the
 * timeline for the referenced tool call. Returns `null` when the ref does
 * not match any element-bearing result.
 *
 * When `elementIds` is provided, filters to that subset (matched against the
 * `id` field on stored elements, or `<type>/<id>` for raw query_osm entries).
 */
export function resolveMapMarkers(
	ref: string,
	elementIds: string[] | undefined,
	items: TimelineItem[],
	currentIndex?: number,
): MapMarker[] | null {
	const item = findRelevantItem(ref, items, currentIndex);
	if (!item) return null;
	let markers = resultToMarkers(item.result);
	if (markers === null) return null;

	if (elementIds) {
		const idSet = new Set(elementIds);
		// For OverpassResultEntry-shaped results, the element identity is
		// `<type>/<id>`; for StoredElement-shaped results it's `el.id` directly.
		markers = markers.filter((_, i) => {
			if (item.result.kind === "query_osm" || item.result.kind === "find_features") {
				const e = item.result.entries[i]!;
				return idSet.has(`${e.type}/${e.id}`);
			}
			if (item.result.kind === "filter") {
				return idSet.has(item.result.entries[i]!.id);
			}
			return true;
		});
	}

	return markers;
}

/**
 * Resolve a `pairsRef` (spatial_join result) to a markers + polylines pair
 * for the map widget. Returns `null` when the ref doesn't match a
 * `spatial_join` result.
 */
export function resolveMapPairs(
	ref: string,
	items: TimelineItem[],
	currentIndex?: number,
): { markers: MapMarker[]; polylines: MapPolyline[] } | null {
	const item = findRelevantItem(ref, items, currentIndex);
	if (!item) return null;
	return resultToPairs(item.result);
}
