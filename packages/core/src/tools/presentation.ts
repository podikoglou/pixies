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
