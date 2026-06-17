import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { NominatimClient } from "../osm/nominatim.ts";
import { OsmServerBusyError, OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { formatNominatimResult, nominatimResultToData } from "../osm/format.ts";
import type { ReverseGeocodeToolDetails } from "./index.ts";
import type { ToolProgress } from "./progress.ts";

const schema = Type.Object({
	lat: Type.Number({ description: "Latitude" }),
	lon: Type.Number({ description: "Longitude" }),
	zoom: Type.Optional(
		Type.Number({
			description:
				"Address granularity 0-18 (18=building, 14=street, 10=suburb, 3=country). Default 18.",
		}),
	),
});

export function createReverseGeocodeTool(
	nominatim: NominatimClient,
): AgentTool<typeof schema, ToolProgress | ReverseGeocodeToolDetails | undefined> {
	return {
		name: "reverse_geocode",
		label: "Reverse geocode",
		description:
			"Reverse geocode coordinates to a place name and address using Nominatim. Returns display_name, address breakdown, and OSM element reference. Use for 'what is at these coordinates' queries.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new Error("Operation aborted");
			try {
				const result = await nominatim.reverse(
					params.lat,
					params.lon,
					{ zoom: params.zoom },
					signal,
					{
						onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
					},
				);
				if (!result || !result.display_name) {
					return {
						content: [{ type: "text", text: "No results." }],
						details: undefined,
					};
				}
				const name = result.name || result.display_name.split(",")[0] || "unknown";
				return {
					content: [{ type: "text", text: formatNominatimResult(result) }],
					details: { name: name.slice(0, 50), data: nominatimResultToData(result) },
				};
			} catch (err) {
				if (err instanceof OsmServerBusyError) {
					return { content: [{ type: "text", text: OSM_SERVER_BUSY_MESSAGE }], details: undefined };
				}
				throw err;
			}
		},
	};
}
