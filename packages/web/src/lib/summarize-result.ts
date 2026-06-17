import type { ToolResult } from "@pixies/core";

export function summarizeResult(result: ToolResult): string | null {
	switch (result.kind) {
		case "geocode": {
			const top = result.entries[0];
			if (!top) return null;
			const name = top.name || top.displayName?.split(",")[0] || "unknown";
			return `${name} (${top.lat},${top.lon})`;
		}
		case "reverse_geocode":
			return result.entry.name;
		case "query_osm":
			return `${result.entries.length} elements`;
		case "display_map":
			return `${result.data.markers.length} marker(s)`;
		case "empty":
			return null;
	}
}
