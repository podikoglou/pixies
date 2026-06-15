import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { NominatimClient } from "../osm/nominatim.ts";
import { formatNominatimResult, nominatimResultToData } from "../osm/format.ts";
import type { GeocodeToolDetails } from "./index.ts";
import type { ToolProgress } from "./progress.ts";

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
			const results = await nominatim.search(params.query, { limit: params.limit }, signal, {
				onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
			});
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results." }],
					details: { top: "no results", data: [] },
				};
			}
			const lines = results.map(formatNominatimResult);
			const data = results.map(nominatimResultToData);
			const top = results[0];
			if (!top) throw new Error("No top result");
			const topName = top.name || top.display_name?.split(",")[0] || "unknown";
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { top: `${topName} (${top.lat},${top.lon})`, data },
			};
		},
	};
}
