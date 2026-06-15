import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

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

type ToolNameLabel = Record<ToolName, string>;

const TOOL_LABELS: ToolNameLabel = {
	geocode: "Geocode",
	reverse_geocode: "Reverse geocode",
	query_osm: "Query OSM",
	display_map: "Display Map",
};

/** Return a human-readable label for a tool name. Falls back to title-casing the snake_case name. */
export function toolLabel(name: string): string {
	if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name as ToolName];
	return name
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

type ToolDetailSummarizer<T extends ToolName> = (
	details: import("./index.ts").ToolDetailsMap[T],
) => string | undefined;

const summarize: { [K in ToolName]: ToolDetailSummarizer<K> } = {
	geocode: (d) => (typeof d.top === "string" ? d.top : undefined),
	reverse_geocode: (d) => (d && typeof d.name === "string" ? d.name : undefined),
	query_osm: (d) => (typeof d.count === "number" ? `${d.count} elements` : undefined),
	display_map: (d) => `${d.data.markers.length} marker(s)`,
};

/** Summarize tool details into a human-readable string, or undefined if unavailable. */
export function summarizeToolDetails<K extends ToolName>(
	name: K,
	details: import("./index.ts").ToolDetailsMap[K],
): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	return summarize[name](details);
}
