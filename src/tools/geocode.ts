import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatNominatimResult } from "../osm/format.ts";
import { nominatim } from "../osm/nominatim.ts";

const schema = Type.Object({
	query: Type.String({
		description: "Free-form place query, e.g. 'Berlin', '123 Main St, London', 'Eiffel Tower'",
	}),
	limit: Type.Optional(
		Type.Number({ description: "Max results (Nominatim max 40, default 10)" }),
	),
});

export interface GeocodeToolDetails {
	top?: string;
}

export const geocodeTool: AgentTool<typeof schema, GeocodeToolDetails | undefined> = {
	name: "geocode",
	label: "Geocode",
	description:
		"Geocode a place name or address to coordinates and OSM metadata using Nominatim. Returns ranked matches with display_name, lat/lon, osm_type/osm_id, and category. Use for resolving place names to coordinates before running an Overpass query.",
	parameters: schema,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const results = await nominatim.search(params.query, { limit: params.limit }, signal);
		if (results.length === 0) {
			return {
				content: [{ type: "text", text: "No results." }],
				details: { top: "no results" },
			};
		}
		const lines = results.map(formatNominatimResult);
		const top = results[0];
		if (!top) throw new Error("No top result");
		const topName = top.name || top.display_name?.split(",")[0] || "unknown";
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { top: `${topName} (${top.lat},${top.lon})` },
		};
	},
};
