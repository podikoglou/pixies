import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GeocodeToolDetails } from "./geocode.ts";
import { geocodeTool } from "./geocode.ts";
import type { QueryOsmToolDetails } from "./query-osm.ts";
import { queryOsmTool } from "./query-osm.ts";
import type { ReverseGeocodeToolDetails } from "./reverse-geocode.ts";
import { reverseGeocodeTool } from "./reverse-geocode.ts";

export type { GeocodeToolDetails, ReverseGeocodeToolDetails, QueryOsmToolDetails };

export type ToolName = "geocode" | "reverse_geocode" | "query_osm";

export type ToolRegistry = {
	geocode: typeof geocodeTool;
	reverse_geocode: typeof reverseGeocodeTool;
	query_osm: typeof queryOsmTool;
};

export type ToolDetailsMap = {
	geocode: GeocodeToolDetails;
	reverse_geocode: ReverseGeocodeToolDetails | undefined;
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

export const toolRegistry: ToolRegistry = {
	geocode: geocodeTool,
	reverse_geocode: reverseGeocodeTool,
	query_osm: queryOsmTool,
};

export const tools: AgentTool[] = [geocodeTool, reverseGeocodeTool, queryOsmTool];

export function summarizeToolDetails(name: string, details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (name === "geocode" && typeof d.top === "string") return d.top;
	if (name === "reverse_geocode" && typeof d.name === "string") return d.name;
	if (name === "query_osm" && typeof d.count === "number") return `${d.count} elements`;
	return undefined;
}

export { geocodeTool, queryOsmTool, reverseGeocodeTool };
