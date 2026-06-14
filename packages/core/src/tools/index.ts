import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NominatimClient } from "../osm/nominatim.ts";
import type { OverpassClient } from "../osm/overpass.ts";
import { createGeocodeTool } from "./geocode.ts";
import type { GeocodeToolDetails } from "./geocode.ts";
import { createQueryOsmTool } from "./query-osm.ts";
import type { QueryOsmToolDetails } from "./query-osm.ts";
import { createReverseGeocodeTool } from "./reverse-geocode.ts";
import type { ReverseGeocodeToolDetails } from "./reverse-geocode.ts";
import type { ToolName } from "./presentation.ts";

export type { GeocodeToolDetails, ReverseGeocodeToolDetails, QueryOsmToolDetails, ToolName };

export interface OsmClients {
	nominatim: NominatimClient;
	overpass: OverpassClient;
}

export type ToolRegistry = {
	geocode: AgentTool;
	reverse_geocode: AgentTool;
	query_osm: AgentTool;
};

export type ToolDetailsMap = {
	geocode: GeocodeToolDetails;
	reverse_geocode: ReverseGeocodeToolDetails | undefined;
	query_osm: QueryOsmToolDetails;
};

/** Extracts only the final-result shape from each tool's details union (excludes queued state). */
export type ToolFinalDetailsMap = {
	geocode: { top?: string };
	reverse_geocode: { name?: string } | undefined;
	query_osm: QueryOsmToolDetails;
};

export type ToolDetails = ToolDetailsMap[ToolName];

export type ToolDetailVariant<T extends ToolName> = {
	name: T;
	details: ToolDetailsMap[T];
};

export type ToolDetailsDiscriminatedUnion = {
	[K in ToolName]: ToolDetailVariant<K>;
}[ToolName];

export function createToolRegistry(clients: OsmClients): ToolRegistry {
	const geocode = createGeocodeTool(clients.nominatim);
	const reverseGeocode = createReverseGeocodeTool(clients.nominatim);
	const queryOsm = createQueryOsmTool(clients.overpass);
	return { geocode, reverse_geocode: reverseGeocode, query_osm: queryOsm };
}

export function createTools(clients: OsmClients): AgentTool[] {
	const registry = createToolRegistry(clients);
	return [registry.geocode, registry.reverse_geocode, registry.query_osm];
}

export { toolLabel, summarizeToolDetails } from "./presentation.ts";
