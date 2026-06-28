import { Type } from "typebox";
import { DisplayMapValidationError, UnknownRefError } from "../errors.ts";
import {
	DisplayMapToolDetailsSchema,
	type DisplayMapData,
	type DisplayMapToolDetails,
} from "./schemas.ts";
import { defineTool, parseSchema } from "./tool-module.ts";
import type { DependencyContext } from "./dependency-graph.ts";
import { resolveRef } from "./dependency-graph.ts";
import { throwIfAborted } from "./control-flow.ts";

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
			description: "Inline marker points. Use for hand-picked points not from another tool.",
		}),
	),
	queryRef: Type.Optional(
		Type.String({
			description:
				"Tool call ID of a prior query_osm / find_features / filter / geocode call. The map resolves markers from that result automatically — do not re-list every marker inline.",
		}),
	),
	/**
	 * Tool call ID of a prior find_features / filter / geocode result. Same
	 * resolution path as queryRef, but the name signals intent (the ref points
	 * at element-bearing results from the new tool layer). Accepts both for
	 * compatibility with refs the model may emit under either name.
	 */
	elementsRef: Type.Optional(
		Type.String({
			description:
				"Tool call ID of a prior result. Displays all elements from that result as markers. Alternative to markers / queryRef.",
		}),
	),
	/**
	 * Tool call ID of a prior spatial_join result. The map draws markers for
	 * each point and target plus a polyline connecting matched pairs.
	 */
	pairsRef: Type.Optional(
		Type.String({
			description:
				"Tool call ID of a prior spatial_join result. Displays both points and targets, with lines connecting matched pairs.",
		}),
	),
	elementIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'OSM element IDs (e.g. "node/12345") to show a subset of the referenced query results.',
		}),
	),
	bounds: Type.Optional(boundsSchema),
	/**
	 * Clear the map before adding the new markers/pairs. Default: false
	 * (markers accumulate across calls). The current web client renders each
	 * display_map call as its own card with its own map, so this is a
	 * forward-looking parameter for a future single-map UX.
	 */
	clear: Type.Optional(Type.Boolean({ description: "If true, clears existing markers first." })),
});

/**
 * The XOR of marker-source parameters. Exactly one of `markers`, `queryRef`,
 * `elementsRef`, `pairsRef` must be set; providing more than one is a model
 * error surfaced as a tool error.
 */
function detectSource(params: DisplayMapInput): MarkerSource | "multiple" | null {
	const sources: MarkerSource[] = [];
	if (params.markers !== undefined) sources.push("markers");
	if (params.queryRef !== undefined) sources.push("queryRef");
	if (params.elementsRef !== undefined) sources.push("elementsRef");
	if (params.pairsRef !== undefined) sources.push("pairsRef");
	if (sources.length === 0) return null;
	if (sources.length > 1) return "multiple";
	return sources[0]!;
}

type MarkerSource = "markers" | "queryRef" | "elementsRef" | "pairsRef";

type DisplayMapInput = {
	markers?: { lat: number; lon: number; label?: string }[];
	queryRef?: string;
	elementsRef?: string;
	pairsRef?: string;
	elementIds?: string[];
	bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
	clear?: boolean;
};

export type DisplayMapContext = DependencyContext;

export const displayMapModule = defineTool<
	{ kind: "display_map"; data: DisplayMapData },
	DisplayMapContext,
	typeof schema,
	DisplayMapToolDetails
>({
	name: "display_map",
	label: "Display Map",
	description: `Display markers on a map in the UI. Provide exactly one of:
- markers (inline points for hand-picked locations)
- queryRef / elementsRef (a prior find_features / filter / geocode / query_osm tool call ID — markers resolve automatically)
- pairsRef (a prior spatial_join tool call ID — draws markers for both sides and lines between matched pairs)

Add elementIds to show a subset of a referenced result. The map IS the primary output — produce no text response when calling display_map.`,
	parameters: schema,
	detailsSchema: DisplayMapToolDetailsSchema,
	parse: parseSchema(DisplayMapToolDetailsSchema, (d) => ({ kind: "display_map", data: d.data })),
	execute: async (ctx, _toolCallId, params, signal) => {
		throwIfAborted(signal);
		// display_map does not write to the result store (per the design: it
		// produces no element-bearing result). But it DOES register with the
		// coordinator so that, when its ref points to an in-flight sibling
		// (e.g. a spatial_join in the same batch), it waits for that sibling
		// to complete and appear in the client's timeline before itself
		// completing — otherwise the client's ref resolution races and the
		// map renders empty.
		//
		// The done() callback is invoked with null (no stored result). For
		// refs to tools that do not participate in the dependency layer
		// (legacy query_osm / geocode results from a prior turn),
		// `resolveRef` throws UnknownRefError — we swallow that and forward
		// the ref string as-is, preserving the pre-experiment behaviour.
		const reg = ctx.coordinator.register(_toolCallId);
		try {
			const source = detectSource(params);
			if (source === null) {
				throw new DisplayMapValidationError({
					reason: "neither",
					message: "Provide one of: markers, queryRef, elementsRef, or pairsRef.",
				});
			}
			if (source === "multiple") {
				throw new DisplayMapValidationError({
					reason: "both",
					message:
						"Provide exactly one of: markers, queryRef, elementsRef, or pairsRef (not multiple).",
				});
			}
			// UnknownRefError means the ref targets a non-participating tool
			// (legacy path) — fall through and forward the ref verbatim.
			const refId = params.queryRef ?? params.elementsRef ?? params.pairsRef;
			if (refId) {
				await resolveRef(ctx, _toolCallId, refId, signal).catch((e: unknown) => {
					if (e instanceof UnknownRefError) return;
					throw e;
				});
			}

			// Forward everything the client needs to render. The client does
			// its own resolution by walking its in-memory timeline.
			return {
				content: [
					{
						type: "text",
						text: forwardText(params, source),
					},
				],
				details: {
					data: {
						...(params.markers ? { markers: params.markers } : { markers: [] }),
						...(params.queryRef ? { queryRef: params.queryRef } : {}),
						...(params.elementsRef ? { elementsRef: params.elementsRef } : {}),
						...(params.pairsRef ? { pairsRef: params.pairsRef } : {}),
						...(params.elementIds ? { elementIds: params.elementIds } : {}),
						...(params.bounds ? { bounds: params.bounds } : {}),
					},
				},
			};
		} finally {
			reg.done(null);
		}
	},
});

/** Build the model-facing text describing what was displayed. */
function forwardText(params: DisplayMapInput, source: MarkerSource): string {
	switch (source) {
		case "markers":
			return `Displaying ${params.markers!.length} marker(s) on map.`;
		case "queryRef":
			return `Displaying markers from query_osm / find_features call ${params.queryRef} on map.`;
		case "elementsRef":
			return `Displaying elements from result ${params.elementsRef} on map.`;
		case "pairsRef":
			return `Displaying spatial_join pairs from ${params.pairsRef} on map (points + targets + connecting lines).`;
		default:
			return "Displaying map.";
	}
}
