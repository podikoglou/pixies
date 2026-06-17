import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { geocodeModule } from "./tool-geocode.ts";
import { reverseGeocodeModule } from "./tool-reverse-geocode.ts";
import { queryOsmModule } from "./tool-query-osm.ts";
import { displayMapModule } from "./tool-display-map.ts";
import type { ToolModule, OsmClients } from "./tool-module.ts";
import type {
	DisplayMapToolDetails,
	GeocodeResultEntry,
	OverpassResultEntry,
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
} from "./schemas.ts";

const TOOL_MODULES = {
	geocode: geocodeModule,
	reverse_geocode: reverseGeocodeModule,
	query_osm: queryOsmModule,
	display_map: displayMapModule,
} as const;

const TOOL_NAMES = Object.keys(TOOL_MODULES) as ToolName[];

export type ToolName = keyof typeof TOOL_MODULES;

export const ToolNameSchema = Type.Union(TOOL_NAMES.map((k) => Type.Literal(k as ToolName)));

export function isToolName(value: unknown): value is ToolName {
	return Value.Check(ToolNameSchema, value);
}

export type ToolRegistry = { [K in ToolName]: AgentTool };

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

export const ToolDetailsDiscriminatedUnionSchema = Type.Union(
	TOOL_NAMES.map((name) => {
		const mod = TOOL_MODULES[name];
		const details =
			name === "reverse_geocode" ? Type.Optional(mod.detailsSchema) : mod.detailsSchema;
		return Type.Object({
			name: Type.Literal(name),
			details,
		});
	}) as unknown as [TSchema, ...TSchema[]],
);

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

export type ToolResultData = {
	geocode: GeocodeResultEntry[];
	reverse_geocode: GeocodeResultEntry;
	query_osm: OverpassResultEntry[];
	display_map: DisplayMapToolDetails["data"];
};

export function createToolRegistry(clients: OsmClients): ToolRegistry {
	const registry: Record<string, AgentTool> = {};
	for (const [name, mod] of Object.entries(TOOL_MODULES)) {
		registry[name] = mod.factory(clients);
	}
	return registry as ToolRegistry;
}

export function createTools(clients: OsmClients): AgentTool[] {
	return Object.values(TOOL_MODULES).map((mod) => mod.factory(clients));
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
