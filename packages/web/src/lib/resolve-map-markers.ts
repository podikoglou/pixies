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
 * A marker plus the source element's stable identity. The identity is
 * threaded through so `elementIds` filtering matches the source element
 * (NOT by marker-array position — no-coords entries are filtered out before
 * markers, so positional matching would silently reference the wrong source
 * element when interspersed).
 */
interface MarkerWithSource {
	lat: number;
	lon: number;
	label?: string;
	sourceId: string;
}

/**
 * Normalise any element-bearing tool result into a list of markers carrying
 * the source element's identity. Returns `null` when the result kind carries
 * no element data (`display_map`, `query_osm` raw payload, `empty`,
 * `find_features_busy`).
 */
function resultToMarkers(result: ToolResult): MarkerWithSource[] | null {
	switch (result.kind) {
		case "query_osm":
		case "find_features":
			return result.entries
				.filter(
					(e): e is OverpassResultEntry & { lat: number; lon: number } =>
						e.lat != null && e.lon != null,
				)
				.map((e) => ({
					lat: e.lat,
					lon: e.lon,
					sourceId: `${e.type}/${e.id}`,
					...(e.name ? { label: e.name } : {}),
				}));
		case "filter":
			return storedElementsToMarkers(result.entries);
		case "spatial_join":
			return storedElementsToMarkers(result.pairs.flatMap((p) => [p.point, p.target]));
		case "geocode":
			return result.entries.map((e) => ({
				lat: e.lat,
				lon: e.lon,
				sourceId:
					e.osmType && e.osmId !== undefined ? `${e.osmType}/${e.osmId}` : `place/${e.placeId}`,
				...(e.name ? { label: e.name } : {}),
			}));
		case "reverse_geocode":
			return [
				{
					lat: result.entry.lat,
					lon: result.entry.lon,
					sourceId:
						result.entry.osmType && result.entry.osmId !== undefined
							? `${result.entry.osmType}/${result.entry.osmId}`
							: `place/${result.entry.placeId}`,
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

function storedElementsToMarkers(entries: StoredElement[]): MarkerWithSource[] {
	const seen = new Set<string>();
	const out: MarkerWithSource[] = [];
	for (const el of entries) {
		if (el.lat === undefined || el.lon === undefined) continue;
		if (seen.has(el.id)) continue;
		seen.add(el.id);
		if (el.lat === undefined || el.lon === undefined) continue;
		out.push({
			lat: el.lat,
			lon: el.lon,
			sourceId: el.id,
			...(el.name ? { label: el.name } : {}),
		});
	}
	return out;
}

function storedElementToMarker(el: StoredElement): MapMarker | null {
	if (el.lat === undefined || el.lon === undefined) return null;
	return { lat: el.lat, lon: el.lon, ...(el.name ? { label: el.name } : {}) };
}

/** Strip the `sourceId` field to produce the public {@link MapMarker} shape. */
function toPublicMarkers(ms: MarkerWithSource[]): MapMarker[] {
	return ms.map(({ lat, lon, label }) => ({ lat, lon, ...(label ? { label } : {}) }));
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
 * When `elementIds` is provided, filters to that subset, matched against the
 * source element's stable identity (NOT positional index).
 */
export function resolveMapMarkers(
	ref: string,
	elementIds: string[] | undefined,
	items: TimelineItem[],
	currentIndex?: number,
): MapMarker[] | null {
	const item = findRelevantItem(ref, items, currentIndex);
	if (!item) return null;
	const withSource = resultToMarkers(item.result);
	if (withSource === null) return null;

	const filtered = elementIds
		? withSource.filter((m) => new Set(elementIds).has(m.sourceId))
		: withSource;

	return toPublicMarkers(filtered);
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
