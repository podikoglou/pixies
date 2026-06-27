import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NominatimClient } from "../clients/nominatim.ts";
import type { OverpassClient } from "../clients/overpass.ts";
import { geocodeModule } from "./tool-geocode.ts";
import { reverseGeocodeModule } from "./tool-reverse-geocode.ts";
import { queryOsmModule } from "./tool-query-osm.ts";
import { displayMapModule } from "./tool-display-map.ts";
import type { ToolModule } from "./tool-module.ts";

const TOOL_MODULES = {
	geocode: geocodeModule,
	reverse_geocode: reverseGeocodeModule,
	query_osm: queryOsmModule,
	display_map: displayMapModule,
} as const;

type ToolName = keyof typeof TOOL_MODULES;

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
 * Build every tool's `AgentTool` from its backing service clients. Each tool's
 * `build` takes just the context it depends on (or nothing, for context-less
 * tools) — the two clients are passed through, not bundled.
 *
 * `builds` is keyed by tool name with a mapped type over `TOOL_MODULES`, so the
 * build path and the parse path cannot silently drift — adding a tool requires
 * touching both, enforced at compile time.
 */
export function createTools(nominatim: NominatimClient, overpass: OverpassClient): AgentTool[] {
	const builds: { [K in keyof typeof TOOL_MODULES]: AgentTool } = {
		geocode: geocodeModule.build({ nominatim }),
		reverse_geocode: reverseGeocodeModule.build({ nominatim }),
		query_osm: queryOsmModule.build({ overpass }),
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

/**
 * Data-fetch tools whose empty / zero-result outcome is a product signal.
 * `display_map` is excluded: it is a UI tool whose emptiness is already
 * observed via the `map_opened`/`marker_count` event, and its
 * `details.data.markers` is empty for `queryRef` maps so it would misclassify.
 */
const DATA_FETCH_TOOLS = ["query_osm", "geocode", "reverse_geocode"] as const;

/**
 * Count the features a successful data-fetch tool call returned, or return
 * `undefined` when the count is not applicable.
 *
 * Returns `undefined` (count not applicable) when:
 * - `toolName` is not a data-fetch tool (e.g. `display_map`, unknown tools); or
 * - `isBusyResult(details)` — the OSM-busy soft-failure is a SUCCESS
 *   (`isError: false`) that signals a transient server issue, not a genuine
 *   zero-feature outcome, and would pollute the empty-rate.
 *
 * Count is derived from the canonical `parseToolResult` parser so it can never
 * drift from the tool's own `details` shape. Shared by the web `tool_empty`
 * event and the server `tool call` event — two consumers of the same
 * count-derivation logic, hence the extraction to core.
 */
export function toolResultCount(toolName: string, details: unknown): number | undefined {
	if (!(DATA_FETCH_TOOLS as readonly string[]).includes(toolName)) return undefined;
	if (isBusyResult(details)) return undefined;

	const parsed = parseToolResult(toolName, details);
	switch (parsed.kind) {
		case "query_osm":
		case "geocode":
			return parsed.entries.length;
		case "reverse_geocode":
			return 1;
		default:
			// `empty` (parse failure / no result) and any other kind → 0.
			return 0;
	}
}
