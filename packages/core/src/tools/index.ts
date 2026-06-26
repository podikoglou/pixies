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
 * Build every tool's `AgentTool` from the `OsmClients` bag. This is the only
 * place that knows the bag; each tool's `build` takes just the context it
 * depends on (or nothing, for context-less tools).
 *
 * `builds` is keyed by tool name with a mapped type over `TOOL_MODULES`, so the
 * build path and the parse path cannot silently drift — adding a tool requires
 * touching both, enforced at compile time.
 */
export function createTools(clients: OsmClients): AgentTool[] {
	const builds: { [K in keyof typeof TOOL_MODULES]: AgentTool } = {
		geocode: geocodeModule.build({ nominatim: clients.nominatim }),
		reverse_geocode: reverseGeocodeModule.build({ nominatim: clients.nominatim }),
		query_osm: queryOsmModule.build({ overpass: clients.overpass }),
		display_map: displayMapModule.build(),
	};
	return Object.values(builds);
}

type ExtractResult<T> = T extends ToolModule<infer R> ? R : never;

type ToolResultFromModules = ExtractResult<(typeof TOOL_MODULES)[keyof typeof TOOL_MODULES]>;

export type ToolResult = ToolResultFromModules | { kind: "empty" };

export function parseToolResult(toolName: string, details: unknown): ToolResult {
	const mod = TOOL_MODULES[toolName as ToolName];
	if (!mod) return { kind: "empty" };
	return mod.parse(details) ?? { kind: "empty" };
}

/**
 * True when a tool result's `details` marks an OSM-busy soft-failure
 * (`{ busy: true, ... }`). Busy is a SUCCESS (`isError: false`) but a transient
 * server issue, not a genuine zero-feature outcome — both the chat UI and the
 * empty-rate analytics exclude it, so the predicate lives next to
 * `parseToolResult` (the single interpreter of tool-result `details`).
 */
export function isBusyResult(details: unknown): boolean {
	return (details as Record<string, unknown> | null | undefined)?.busy === true;
}
