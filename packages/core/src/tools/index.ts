import type { AgentTool } from "@earendil-works/pi-agent-core";
import { geocodeModule } from "./tool-geocode.ts";
import { reverseGeocodeModule } from "./tool-reverse-geocode.ts";
import { queryOsmModule } from "./tool-query-osm.ts";
import { displayMapModule } from "./tool-display-map.ts";
import type { ToolModule, OsmClients } from "./tool-module.ts";

const TOOL_MODULES = {
	geocode: geocodeModule,
	reverse_geocode: reverseGeocodeModule,
	query_osm: queryOsmModule,
	display_map: displayMapModule,
} as const;

type ToolName = keyof typeof TOOL_MODULES;

export type { OsmClients } from "./tool-module.ts";

export type { ToolProgress } from "./progress.ts";
export { ToolProgressSchema, isToolProgress } from "./progress.ts";

export {
	GeocodeResultEntrySchema,
	OverpassResultEntrySchema,
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapDataSchema,
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
 * Wire every tool to the single OSM client it needs. This is the only place
 * that knows the `OsmClients` bag; each tool's `build` takes just the client it
 * depends on (or nothing, for client-less tools).
 */
export function createTools(clients: OsmClients): AgentTool[] {
	return [
		geocodeModule.build({ nominatim: clients.nominatim }),
		reverseGeocodeModule.build({ nominatim: clients.nominatim }),
		queryOsmModule.build({ overpass: clients.overpass }),
		displayMapModule.build(),
	];
}

type ExtractResult<T> = T extends ToolModule<infer R> ? R : never;

type ToolResultFromModules = ExtractResult<(typeof TOOL_MODULES)[keyof typeof TOOL_MODULES]>;

export type ToolResult = ToolResultFromModules | { kind: "empty" };

export function parseToolResult(toolName: string, details: unknown): ToolResult {
	const mod = TOOL_MODULES[toolName as ToolName];
	if (!mod) return { kind: "empty" };
	return mod.parse(details) ?? { kind: "empty" };
}

export function summarizeToolResult(result: ToolResult): string | null {
	if (result.kind === "empty") return null;
	const mod = TOOL_MODULES[result.kind as ToolName];
	return mod?.summarize(result as never) ?? null;
}
