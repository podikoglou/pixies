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
	markers: Type.Optional(
		Type.Array(markerSchema, {
			description: "Inline marker points. Use for hand-picked points not from query_osm.",
		}),
	),
	queryRef: Type.Optional(
		Type.String({
			description:
				"Tool call ID of a prior query_osm call. The map resolves markers from that query automatically — do not re-list every marker inline.",
		}),
	),
	elementIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'OSM element IDs (e.g. "node/12345") to show a subset of the referenced query results.',
		}),
	),
	bounds: Type.Optional(boundsSchema),
});

export function createDisplayMapTool(): AgentTool<typeof schema, DisplayMapToolDetails> {
	return {
		name: "display_map",
		label: "Display Map",
		description:
			"Display markers on a map in the UI. For query_osm results, pass queryRef (the tool call ID of that query) instead of re-listing markers. Add elementIds to show a subset. Use inline markers only for hand-picked points.",
		parameters: schema,
		async execute(_toolCallId, params) {
			const hasMarkers = params.markers !== undefined;
			const hasQueryRef = params.queryRef !== undefined;

			if (hasMarkers && hasQueryRef) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Provide either markers (inline) or queryRef (reference to a prior query_osm call), not both.",
						},
					],
					details: { data: { markers: [], bounds: params.bounds } },
				};
			}

			if (!hasMarkers && !hasQueryRef) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Provide either markers (inline) or queryRef (reference to a prior query_osm call).",
						},
					],
					details: { data: { markers: [], bounds: params.bounds } },
				};
			}

			if (hasQueryRef) {
				return {
					content: [
						{
							type: "text",
							text: `Displaying markers from query_osm call ${params.queryRef} on map.`,
						},
					],
					details: {
						data: {
							markers: [],
							queryRef: params.queryRef,
							elementIds: params.elementIds,
							bounds: params.bounds,
						},
					},
				};
			}

			return {
				content: [{ type: "text", text: `Displaying ${params.markers!.length} marker(s) on map.` }],
				details: {
					data: {
						markers: params.markers!,
						bounds: params.bounds,
					},
				},
			};
		},
	};
}
