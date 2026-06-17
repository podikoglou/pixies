import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NominatimClient } from "../osm/nominatim.ts";
import type { OverpassClient } from "../osm/overpass.ts";
import { createGeocodeTool } from "./geocode.ts";
import { createQueryOsmTool } from "./query-osm.ts";
import { createReverseGeocodeTool } from "./reverse-geocode.ts";
import { createDisplayMapTool } from "./display-map.ts";
import type { ToolName } from "./presentation.ts";
export type { ToolName } from "./presentation.ts";
export { ToolNameSchema, isToolName } from "./presentation.ts";

export type { ToolProgress } from "./progress.ts";
export { ToolProgressSchema, isToolProgress } from "./progress.ts";

export const GeocodeResultEntrySchema = Type.Object({
	placeId: Type.Number(),
	lat: Type.Number(),
	lon: Type.Number(),
	name: Type.String(),
	displayName: Type.Optional(Type.String()),
	class: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	osmType: Type.Optional(
		Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	),
	osmId: Type.Optional(Type.Number()),
});
export type GeocodeResultEntry = Static<typeof GeocodeResultEntrySchema>;

export const OverpassResultEntrySchema = Type.Object({
	type: Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	id: Type.Number(),
	lat: Type.Optional(Type.Number()),
	lon: Type.Optional(Type.Number()),
	name: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Record(Type.String(), Type.String())),
	geometryPoints: Type.Optional(Type.Number()),
});
export type OverpassResultEntry = Static<typeof OverpassResultEntrySchema>;

/**
 * Per-tool structured result data, keyed by tool name. Tools populate this
 * alongside the model-facing `content` text; adapters that want structure
 * (e.g. the web `JsonTree`) consume it directly via `result.details.data`
 * instead of reverse-parsing the pipe string. See issue #15.
 */
export type ToolResultData = {
	geocode: GeocodeResultEntry[];
	reverse_geocode: GeocodeResultEntry;
	query_osm: OverpassResultEntry[];
	display_map: DisplayMapToolDetails["data"];
};

export const GeocodeToolDetailsSchema = Type.Object({
	top: Type.Optional(Type.String()),
	data: Type.Array(GeocodeResultEntrySchema),
});
export type GeocodeToolDetails = Static<typeof GeocodeToolDetailsSchema>;

export const ReverseGeocodeToolDetailsSchema = Type.Object({
	name: Type.Optional(Type.String()),
	data: GeocodeResultEntrySchema,
});
export type ReverseGeocodeToolDetails = Static<typeof ReverseGeocodeToolDetailsSchema>;

export const QueryOsmToolDetailsSchema = Type.Object({
	count: Type.Number(),
	data: Type.Array(OverpassResultEntrySchema),
});
export type QueryOsmToolDetails = Static<typeof QueryOsmToolDetailsSchema>;

export const DisplayMapDataSchema = Type.Object({
	markers: Type.Array(
		Type.Object({
			lat: Type.Number(),
			lon: Type.Number(),
			label: Type.Optional(Type.String()),
		}),
	),
	queryRef: Type.Optional(Type.String()),
	elementIds: Type.Optional(Type.Array(Type.String())),
	bounds: Type.Optional(
		Type.Object({
			minlat: Type.Number(),
			minlon: Type.Number(),
			maxlat: Type.Number(),
			maxlon: Type.Number(),
		}),
	),
});
export type DisplayMapData = Static<typeof DisplayMapDataSchema>;

export function isDisplayMapData(data: unknown): data is DisplayMapData {
	return Value.Check(DisplayMapDataSchema, data);
}

export const DisplayMapToolDetailsSchema = Type.Object({
	data: DisplayMapDataSchema,
});
export type DisplayMapToolDetails = Static<typeof DisplayMapToolDetailsSchema>;

export interface OsmClients {
	nominatim: NominatimClient;
	overpass: OverpassClient;
}

export type ToolRegistry = {
	geocode: AgentTool;
	reverse_geocode: AgentTool;
	query_osm: AgentTool;
	display_map: AgentTool;
};

export type ToolDetailsMap = {
	geocode: GeocodeToolDetails;
	reverse_geocode: ReverseGeocodeToolDetails | undefined;
	query_osm: QueryOsmToolDetails;
	display_map: DisplayMapToolDetails;
};

export type ToolDetails = ToolDetailsMap[ToolName];

export type ToolDetailVariant<T extends ToolName> = {
	name: T;
	details: ToolDetailsMap[T];
};

export type ToolDetailsDiscriminatedUnion = {
	[K in ToolName]: ToolDetailVariant<K>;
}[ToolName];

export const ToolDetailsDiscriminatedUnionSchema = Type.Union([
	Type.Object({ name: Type.Literal("geocode"), details: GeocodeToolDetailsSchema }),
	Type.Object({
		name: Type.Literal("reverse_geocode"),
		details: Type.Optional(ReverseGeocodeToolDetailsSchema),
	}),
	Type.Object({ name: Type.Literal("query_osm"), details: QueryOsmToolDetailsSchema }),
	Type.Object({ name: Type.Literal("display_map"), details: DisplayMapToolDetailsSchema }),
]);

export function createToolRegistry(clients: OsmClients): ToolRegistry {
	const geocode = createGeocodeTool(clients.nominatim);
	const reverseGeocode = createReverseGeocodeTool(clients.nominatim);
	const queryOsm = createQueryOsmTool(clients.overpass);
	const displayMap = createDisplayMapTool();
	return { geocode, reverse_geocode: reverseGeocode, query_osm: queryOsm, display_map: displayMap };
}

export function createTools(clients: OsmClients): AgentTool[] {
	const registry = createToolRegistry(clients);
	return [registry.geocode, registry.reverse_geocode, registry.query_osm, registry.display_map];
}

export { toolLabel } from "./presentation.ts";
export { parseToolResult, summarizeResult } from "./parse-result.ts";
export type { ToolResult } from "./parse-result.ts";
