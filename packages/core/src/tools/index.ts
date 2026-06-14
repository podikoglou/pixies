import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GeocodeToolDetails } from "./geocode.ts";
import { geocodeTool } from "./geocode.ts";
import type { QueryOsmToolDetails } from "./query-osm.ts";
import { queryOsmTool } from "./query-osm.ts";
import type { ReverseGeocodeToolDetails } from "./reverse-geocode.ts";
import { reverseGeocodeTool } from "./reverse-geocode.ts";
import type { ToolName } from "./presentation.ts";

export type { GeocodeToolDetails, ReverseGeocodeToolDetails, QueryOsmToolDetails, ToolName };

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

export const toolRegistry: ToolRegistry = {
	geocode: geocodeTool,
	reverse_geocode: reverseGeocodeTool,
	query_osm: queryOsmTool,
};

export const tools: AgentTool[] = [geocodeTool, reverseGeocodeTool, queryOsmTool];

export { toolLabel, summarizeToolDetails } from "./presentation.ts";

export { geocodeTool, queryOsmTool, reverseGeocodeTool };
