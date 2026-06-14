import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { formatNominatimResult } from "../osm/format.ts";
import { nominatim } from "../osm/nominatim.ts";

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

export interface ReverseGeocodeToolDetails {
	name?: string;
}

export const reverseGeocodeTool: AgentTool<typeof schema, ReverseGeocodeToolDetails | undefined> = {
	name: "reverse_geocode",
	label: "Reverse geocode",
	description:
		"Reverse geocode coordinates to a place name and address using Nominatim. Returns display_name, address breakdown, and OSM element reference. Use for 'what is at these coordinates' queries.",
	parameters: schema,
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, onUpdate) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const result = await nominatim.reverse(
			params.lat,
			params.lon,
			{ zoom: params.zoom },
			signal,
			{
				onQueued: () => onUpdate?.({ content: [], details: { queued: true } as any }),
				onStart: () => onUpdate?.({ content: [], details: { queued: false } as any }),
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
			details: { name: name.slice(0, 50) },
		};
	},
};
