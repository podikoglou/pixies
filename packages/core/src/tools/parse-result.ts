import { Value } from "typebox/value";
import {
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapToolDetailsSchema,
} from "./schemas.ts";
import type { GeocodeResultEntry, OverpassResultEntry, DisplayMapData } from "./schemas.ts";

/**
 * Typed, validated tool result. This is what downstream consumers
 * (frontend reducers, renderers) operate on — never raw `unknown` details.
 *
 * Produced by {@link parseToolResult} from the `unknown` `details` blob that
 * travels along tool executions. Invalid or missing data collapses to the
 * `{ kind: "empty" }` variant, so callers never need null checks.
 */
export type ToolResult =
	| { kind: "query_osm"; entries: OverpassResultEntry[] }
	| { kind: "display_map"; data: DisplayMapData }
	| { kind: "geocode"; entries: GeocodeResultEntry[] }
	| { kind: "reverse_geocode"; entry: GeocodeResultEntry }
	| { kind: "empty" };

/**
 * Validate `unknown` tool `details` against the per-tool TypeBox schema and
 * return the matching {@link ToolResult} variant.
 *
 * This is the single boundary that touches `unknown`. Everything downstream
 * consumes the typed union. Invalid/missing/wrong-shape data — including the
 * malformed `{}` details — collapses to `{ kind: "empty" }`.
 *
 * `toolName` is intentionally a plain `string` (not the narrowed `ToolName`):
 * unknown tool names must degrade gracefully to `{ kind: "empty" }` rather
 * than throw.
 */
export function parseToolResult(toolName: string, details: unknown): ToolResult {
	switch (toolName) {
		case "geocode": {
			if (!Value.Check(GeocodeToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "geocode", entries: details.data };
		}
		case "reverse_geocode": {
			// The reverse_geocode tool returns `details: undefined` on no-result
			// (reverse-geocode.ts:43). Value.Check fails for `undefined`, so this
			// branch naturally falls through to `{ kind: "empty" }`.
			if (!Value.Check(ReverseGeocodeToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "reverse_geocode", entry: details.data };
		}
		case "query_osm": {
			if (!Value.Check(QueryOsmToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "query_osm", entries: details.data };
		}
		case "display_map": {
			if (!Value.Check(DisplayMapToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "display_map", data: details.data };
		}
		default:
			return { kind: "empty" };
	}
}
