import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { NominatimClient } from "../osm/nominatim.ts";
import { OsmServerBusyError, OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { formatNominatimResult, nominatimResultToData } from "../osm/format.ts";
import type { GeocodeToolDetails } from "./index.ts";
import type { ToolProgress } from "./progress.ts";
import { MAX_CONTENT_LINES } from "./limits.ts";

const schema = Type.Object({
	query: Type.String({
		description: "Free-form place query, e.g. 'Berlin', '123 Main St, London', 'Eiffel Tower'",
	}),
	limit: Type.Optional(Type.Number({ description: "Max results (Nominatim max 40, default 10)" })),
});

export function createGeocodeTool(
	nominatim: NominatimClient,
): AgentTool<typeof schema, ToolProgress | GeocodeToolDetails> {
	return {
		name: "geocode",
		label: "Geocode",
		description:
			"Geocode a place name or address to coordinates and OSM metadata using Nominatim. Returns ranked matches with display_name, lat/lon, osm_type/osm_id, and category. Use for resolving place names to coordinates before running an Overpass query.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new Error("Operation aborted");
			try {
				const results = await nominatim.search(params.query, { limit: params.limit }, signal, {
					onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
				});
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results." }],
						details: { top: "no results", data: [] },
					};
				}
				const data = results.map(nominatimResultToData);
				const top = results[0];
				if (!top) throw new Error("No top result");
				const topName = top.name || top.display_name?.split(",")[0] || "unknown";
				const truncated = results.length > MAX_CONTENT_LINES;
				const shown = truncated ? results.slice(0, MAX_CONTENT_LINES) : results;
				const lines = shown.map(formatNominatimResult);
				if (truncated) {
					const rest = results.length - MAX_CONTENT_LINES;
					lines.push(`…and ${rest} more result${rest !== 1 ? "s" : ""}.`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { top: `${topName} (${top.lat},${top.lon})`, data },
				};
			} catch (err) {
				if (err instanceof OsmServerBusyError) {
					return {
						content: [{ type: "text", text: OSM_SERVER_BUSY_MESSAGE }],
						details: { top: "osm server busy", data: [] },
					};
				}
				throw err;
			}
		},
	};
}
