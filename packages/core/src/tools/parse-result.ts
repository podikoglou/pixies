import { Value } from "typebox/value";
import {
	GeocodeToolDetailsSchema,
	ReverseGeocodeToolDetailsSchema,
	QueryOsmToolDetailsSchema,
	DisplayMapToolDetailsSchema,
} from "./index.ts";
import type {
	GeocodeResultEntry,
	OverpassResultEntry,
	DisplayMapData,
	GeocodeToolDetails,
	ReverseGeocodeToolDetails,
	QueryOsmToolDetails,
	DisplayMapToolDetails,
} from "./index.ts";

/**
 * Typed, validated tool result. This is what downstream consumers
 * (frontend reducers, renderers) operate on — never raw `unknown` details.
 *
 * Produced by {@link parseToolResult} from the `unknown` `details` blob that
 * travels along tool executions. Invalid or missing data collapses to the
 * `{ kind: "empty" }` variant, so callers never need null checks.
 *
 * See issue #54.
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
 * malformed `{}` details that crashed `summarizeToolDetails` (see issue #54) —
 * collapses to `{ kind: "empty" }`.
 *
 * `toolName` is intentionally a plain `string` (not the narrowed `ToolName`):
 * unknown tool names must degrade gracefully to `{ kind: "empty" }` rather
 * than throw.
 */
export function parseToolResult(toolName: string, details: unknown): ToolResult {
	switch (toolName) {
		case "geocode": {
			if (!Value.Check(GeocodeToolDetailsSchema, details)) return { kind: "empty" };
			const data: GeocodeResultEntry[] = (details as GeocodeToolDetails).data;
			return { kind: "geocode", entries: data };
		}
		case "reverse_geocode": {
			// The reverse_geocode tool returns `details: undefined` on no-result
			// (reverse-geocode.ts:43). Value.Check fails for `undefined`, so this
			// branch naturally falls through to `{ kind: "empty" }`.
			if (!Value.Check(ReverseGeocodeToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "reverse_geocode", entry: (details as ReverseGeocodeToolDetails).data };
		}
		case "query_osm": {
			if (!Value.Check(QueryOsmToolDetailsSchema, details)) return { kind: "empty" };
			const entries: OverpassResultEntry[] = (details as QueryOsmToolDetails).data;
			return { kind: "query_osm", entries };
		}
		case "display_map": {
			if (!Value.Check(DisplayMapToolDetailsSchema, details)) return { kind: "empty" };
			return { kind: "display_map", data: (details as DisplayMapToolDetails).data };
		}
		default:
			return { kind: "empty" };
	}
}

/**
 * Produce a human-readable summary from a typed {@link ToolResult}, or `null`
 * when no summary is meaningful.
 *
 * Replaces `summarizeToolDetails` for new code: it consumes the validated
 * union directly, so there are no `as` casts and no defensive `undefined`
 * checks. The discriminated union guarantees every accessed field exists.
 *
 * Note (issue #54): two intentional semantic shifts vs the legacy summarizer:
 *   - `geocode`: the legacy `top` string was precomputed at the producer. Here
 *     we reconstruct it from `entries[0]`, mirroring the producer's
 *     `${name || displayName?.split(",")[0] || "unknown"} (${lat},${lon})`.
 *     An empty entry list (no results) yields `null`.
 *   - `reverse_geocode`: returns `entry.name` directly. The legacy summarizer
 *     returned the producer-side `details.name`, which was `name.slice(0, 50)`.
 *     `entry.name` is the full (un-sliced) name — a minor widening that is a
 *     superset of the old value.
 *
 * Return type is `string | null` (NOT `string | undefined` like the legacy
 * summarizer) per the issue spec.
 */
export function summarizeResult(result: ToolResult): string | null {
	switch (result.kind) {
		case "geocode": {
			const top = result.entries[0];
			if (!top) return null;
			const name = top.name || top.displayName?.split(",")[0] || "unknown";
			return `${name} (${top.lat},${top.lon})`;
		}
		case "reverse_geocode":
			return result.entry.name;
		case "query_osm":
			return `${result.entries.length} elements`;
		case "display_map":
			return `${result.data.markers.length} marker(s)`;
		case "empty":
			return null;
	}
}
