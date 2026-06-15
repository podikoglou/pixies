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
): MapMarker[] | null {
	const queryItem = items.find(
		(it): it is Extract<TimelineItem, { kind: "tool-call" }> =>
			it.kind === "tool-call" && it.toolCallId === queryRef,
	);
	if (!queryItem || queryItem.toolName !== "query_osm" || !Array.isArray(queryItem.resultData))
		return null;

	let entries = queryItem.resultData as OverpassResultEntry[];

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
