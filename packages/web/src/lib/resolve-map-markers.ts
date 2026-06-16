import type { OverpassResultEntry } from "@pixies/core";
import type { TimelineItem } from "@/state/chat-reducer";

export interface MapMarker {
	lat: number;
	lon: number;
	label?: string;
}

export function resolveMapMarkers(
	queryRef: string,
	elementIds: string[] | undefined,
	items: TimelineItem[],
	currentIndex?: number,
): MapMarker[] | null {
	let queryItem = items.find(
		(it): it is Extract<TimelineItem, { kind: "tool-call" }> =>
			it.kind === "tool-call" && it.toolCallId === queryRef,
	);
	if (queryItem && queryItem.result.kind !== "query_osm") queryItem = undefined;

	// Fallback: small models may not reproduce long provider-assigned tool-call
	// IDs verbatim. Resolve to the nearest preceding query_osm call instead.
	if (!queryItem) {
		const upperBound = currentIndex ?? items.length;
		for (let i = upperBound - 1; i >= 0; i--) {
			const it = items[i];
			if (
				it &&
				it.kind === "tool-call" &&
				it.toolName === "query_osm" &&
				it.result.kind === "query_osm"
			) {
				queryItem = it;
				break;
			}
		}
	}
	if (!queryItem || queryItem.result.kind !== "query_osm") return null;

	let entries: OverpassResultEntry[] = queryItem.result.entries;

	if (elementIds) {
		const idSet = new Set(elementIds);
		entries = entries.filter((e) => idSet.has(`${e.type}/${e.id}`));
	}

	return entries
		.filter(
			(e): e is OverpassResultEntry & { lat: number; lon: number } =>
				e.lat != null && e.lon != null,
		)
		.map((e) => ({
			lat: e.lat,
			lon: e.lon,
			...(e.name ? { label: e.name } : {}),
		}));
}
