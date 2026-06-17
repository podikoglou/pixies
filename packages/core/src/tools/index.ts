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
import type {
	DisplayMapToolDetails,
	GeocodeResultEntry,
	OverpassResultEntry,
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
} from "./schemas.ts";
import {
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapToolDetailsSchema,
} from "./schemas.ts";

export const ToolNameSchema = Type.Union([
	Type.Literal("geocode"),
	Type.Literal("reverse_geocode"),
	Type.Literal("query_osm"),
	Type.Literal("display_map"),
]);

export type ToolName = Static<typeof ToolNameSchema>;

export function isToolName(value: unknown): value is ToolName {
	return Value.Check(ToolNameSchema, value);
}

export type { ToolProgress } from "./progress.ts";
export { ToolProgressSchema, isToolProgress } from "./progress.ts";

export {
	GeocodeResultEntrySchema,
	OverpassResultEntrySchema,
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapDataSchema,
	isDisplayMapData,
	DisplayMapToolDetailsSchema,
} from "./schemas.ts";
export type {
	GeocodeResultEntry,
	OverpassResultEntry,
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
	DisplayMapData,
	DisplayMapToolDetails,
} from "./schemas.ts";

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

export { parseToolResult } from "./parse-result.ts";
export type { ToolResult } from "./parse-result.ts";
