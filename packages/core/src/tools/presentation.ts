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
