import { Type } from "typebox";
import { Value } from "typebox/value";
import { DisplayMapValidationError } from "../errors.ts";
import {
	DisplayMapToolDetailsSchema,
	type DisplayMapData,
	type DisplayMapToolDetails,
} from "./schemas.ts";
import { defineTool } from "./tool-module.ts";

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

export const displayMapModule = defineTool<
	{ kind: "display_map"; data: DisplayMapData },
	void,
	typeof schema,
	DisplayMapToolDetails
>({
	name: "display_map",
	label: "Display Map",
	description:
		"Display markers on a map in the UI. For query_osm results, pass queryRef (the tool call ID of that query) instead of re-listing markers. Add elementIds to show a subset. Use inline markers only for hand-picked points.",
	parameters: schema,
	detailsSchema: DisplayMapToolDetailsSchema,
	parse: (details) => {
		if (!Value.Check(DisplayMapToolDetailsSchema, details)) return null;
		return { kind: "display_map", data: details.data };
	},
	summarize: (result) => `${result.data.markers.length} marker(s)`,
	factory: () => async (_toolCallId, params) => {
		const hasMarkers = params.markers !== undefined;
		const hasQueryRef = params.queryRef !== undefined;

		if (hasMarkers && hasQueryRef) {
			throw new DisplayMapValidationError({
				reason: "both",
				message:
					"Provide either markers (inline) or queryRef (reference to a prior query_osm call), not both.",
			});
		}

		if (!hasMarkers && !hasQueryRef) {
			throw new DisplayMapValidationError({
				reason: "neither",
				message:
					"Provide either markers (inline) or queryRef (reference to a prior query_osm call).",
			});
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
});
