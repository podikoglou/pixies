import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { DisplayMapToolDetails } from "./index.ts";

const boundsSchema = Type.Object({
	minlat: Type.Number({ description: "Minimum latitude" }),
	minlon: Type.Number({ description: "Minimum longitude" }),
	maxlat: Type.Number({ description: "Maximum latitude" }),
	maxlon: Type.Number({ description: "Maximum longitude" }),
});

const markerSchema = Type.Object({
	lat: Type.Number({ description: "Latitude" }),
	lon: Type.Number({ description: "Longitude" }),
	label: Type.Optional(Type.String({ description: "Marker label" })),
});

const schema = Type.Object({
	markers: Type.Array(markerSchema, { description: "Points to show on the map" }),
	bounds: Type.Optional(boundsSchema),
});

export function createDisplayMapTool(): AgentTool<typeof schema, DisplayMapToolDetails> {
	return {
		name: "display_map",
		label: "Display Map",
		description:
			"Display markers on a map in the UI. Call this after gathering geodata to present spatial results visually. Provide marker points and optionally a bounding box to fit the map viewport.",
		parameters: schema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Displaying ${params.markers.length} marker(s) on map.` }],
				details: {
					data: {
						markers: params.markers,
						bounds: params.bounds,
					},
				},
			};
		},
	};
}
