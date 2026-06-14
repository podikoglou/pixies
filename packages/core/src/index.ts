export { createAgent, createOsmClients } from "./agent.ts";
export type { CreateAgentOptions } from "./agent.ts";
export { SYSTEM_PROMPT } from "./system-prompt.ts";
export type {
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
	ToolName,
	ToolRegistry,
	ToolDetailsMap,
	ToolDetails,
	ToolDetailVariant,
	ToolDetailsDiscriminatedUnion,
	OsmClients,
} from "./tools/index.ts";
export { createToolRegistry, createTools, toolLabel, summarizeToolDetails } from "./tools/index.ts";
export { NominatimClient } from "./osm/nominatim.ts";
export type { NominatimConfig, NominatimResult } from "./osm/nominatim.ts";
export { OverpassClient } from "./osm/overpass.ts";
export type { OverpassConfig, OverpassResponse } from "./osm/overpass.ts";
