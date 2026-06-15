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
export type { ToolProgress } from "./progress.ts";
export { ToolProgressSchema, isToolProgress } from "./progress.ts";

/**
 * Structured, lossless representation of a single geocode or reverse-geocode
 * result. Unlike the model-facing pipe string, this preserves `class` and
 * `type` as separate fields and coerces `lat`/`lon` to numbers once, at the
 * source, instead of in every consumer.
 */
export interface GeocodeResultEntry {
	placeId: number;
	lat: number;
	lon: number;
	name: string;
	displayName?: string;
	class?: string;
	type?: string;
	osmType?: "node" | "way" | "relation";
	osmId?: number;
}

/**
 * Structured, lossless representation of a single Overpass query element.
 * Tag values containing `, ` or `=` survive intact here (the pipe-string
 * parser could not recover them).
 */
export interface OverpassResultEntry {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	name?: string;
	tags?: Record<string, string>;
	geometryPoints?: number;
}

/**
 * Per-tool structured result data, keyed by tool name. Parallels
 * {@link ToolFinalDetailsMap}. Tools populate this alongside the model-facing
 * `content` text; adapters that want structure (e.g. the web `JsonTree`)
 * consume it directly via `result.details.data` instead of reverse-parsing the
 * pipe string. See issue #15.
 */
export type ToolResultData = {
	geocode: GeocodeResultEntry[];
	reverse_geocode: GeocodeResultEntry;
	query_osm: OverpassResultEntry[];
};

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
	geocode: { top?: string; data: ToolResultData["geocode"] };
	reverse_geocode: { name?: string; data: ToolResultData["reverse_geocode"] } | undefined;
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
