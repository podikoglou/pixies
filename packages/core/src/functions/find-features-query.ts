import { boundsAreaKm2, type Bounds } from "./geometry.ts";
import type { TagClause } from "./find-features-types.ts";

/**
 * Overpass QL generation and validation for `find_features`. Kept separate
 * from the tool module so the (substantial) QL-building logic is testable
 * without constructing OSM clients, and so a future Overpass-shaped tool
 * could reuse the validator.
 */

/** Area constraint resolved to a concrete Overpass clause kind. */
export type ResolvedArea =
	| { kind: "bbox"; bounds: Bounds }
	| { kind: "around"; lat: number; lon: number; radius: number };

/**
 * Hard ceiling on the bounding-box area, in km². Queries above this are
 * rejected at validation — the same failure mode the current system prompt
 * warns against ("avoid planet-wide unbounded queries"). Sized to admit a
 * large metropolitan region but reject country-scale scans.
 */
export const MAX_BBOX_AREA_KM2 = 25_000;

/**
 * Hard timeout (seconds) baked into every generated query. Below Overpass's
 * own server-side cap (currently 180s on the public instance) so a runaway
 * query returns to the agent as a remark rather than hanging the request.
 */
export const OVERPASS_TIMEOUT_SECONDS = 30;

/** Render a single tag clause as an Overpass bracket expression. */
export function buildTagClause(c: TagClause): string {
	const key = escapeString(c.key);
	switch (c.op ?? "eq") {
		case "exists":
			return `[${key}]`;
		case "notexists":
			return `[!${key}]`;
		case "neq":
			return `[${key}!=${escapeString(c.value ?? "")}]`;
		case "regex":
			return `[${key}~${escapeString(c.value ?? "")}]`;
		case "iregex":
			return `[${key}~${escapeString(c.value ?? "")},i]`;
		case "eq":
		default:
			return `[${key}=${escapeString(c.value ?? "")}]`;
	}
}

/** Render the spatial constraint portion of a statement. */
export function buildAreaClause(area: ResolvedArea): string {
	switch (area.kind) {
		case "bbox":
			// Overpass bbox order is (south, west, north, east).
			return `(${area.bounds.minlat},${area.bounds.minlon},${area.bounds.maxlat},${area.bounds.maxlon})`;
		case "around":
			return `(around:${area.radius},${area.lat},${area.lon})`;
	}
}

/** Input to {@link generateOverpassQuery}. */
export interface QueryInput {
	/** OR-groups already resolved from `types` / `tags`. Empty list → no filter. */
	groups: TagClause[][];
	/** Optional name regex (already-quoted form, e.g. `"^stockholm"`). */
	nameRegex?: string;
	area: ResolvedArea;
	limit?: number;
	includeGeometry?: boolean;
}

/**
 * Build an Overpass QL query from resolved inputs. Each OR-group becomes a
 * pair of statements (one for `node`, one for `way`) so point-only and
 * area-only features are both covered; relations are omitted for query-size
 * reasons (the spec calls them out as rare for the targeted use cases).
 *
 * The output is always wrapped in a single union `(...)` so the `out`
 * statement deduplicates elements that match multiple groups.
 */
export function generateOverpassQuery(input: QueryInput): string {
	const areaClause = buildAreaClause(input.area);
	const nameClause = input.nameRegex ? `["name"~${escapeString(input.nameRegex)},i]` : "";
	const statements: string[] = [];
	for (const group of input.groups) {
		const tagClauses = group.map(buildTagClause).join("");
		const filter = `${tagClauses}${nameClause}`;
		statements.push(`node${filter}${areaClause};`);
		statements.push(`way${filter}${areaClause};`);
	}
	const outBody = input.includeGeometry ? "geom" : "center";
	const outLimit = input.limit && input.limit > 0 ? ` ${input.limit}` : "";
	return `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];
(
${statements.join("\n")}
);
out ${outBody}${outLimit};`;
}

/** Validation outcome — `errors` is empty when `valid`. */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Lightweight static validation of a generated Overpass QL string. Catches
 * the failure modes `find_features` can produce (and that the model would
 * otherwise see only as a generic Overpass remark): unbalanced brackets,
 * missing spatial constraint, oversized bbox, missing `out` statement.
 *
 * Not a real QL parser — just defensive checks on the output of
 * {@link generateOverpassQuery}. The generator is the trusted path; this is
 * the safety net for hand-edited or future-variant queries.
 */
export function validateOverpassQL(query: string, area: ResolvedArea): ValidationResult {
	const errors: string[] = [];

	const open = (query.match(/\[/g) ?? []).length;
	const close = (query.match(/\]/g) ?? []).length;
	if (open !== close) errors.push(`unbalanced brackets: ${open} '[' vs ${close} ']'`);

	const openP = (query.match(/\(/g) ?? []).length;
	const closeP = (query.match(/\)/g) ?? []).length;
	if (openP !== closeP) errors.push(`unbalanced parentheses: ${openP} '(' vs ${closeP} ')'`);

	if (!/\b(?:out|node|way|relation)\b/.test(query)) {
		errors.push("query has no node/way/relation statements");
	}

	if (!/\bout\b/.test(query)) errors.push("query missing 'out' statement");

	if (area.kind === "bbox") {
		const km2 = boundsAreaKm2(area.bounds);
		if (km2 > MAX_BBOX_AREA_KM2) {
			errors.push(
				`bounding box area (${Math.round(km2)} km²) exceeds safe limit (${MAX_BBOX_AREA_KM2} km²)`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Escape a string for safe interpolation into an Overpass bracket clause.
 * Doubles backslashes and wraps in double quotes. Brackets and semicolons
 * are NOT special inside a quoted Overpass string, so they pass through.
 *
 * Values are user-controlled (model-emitted regex patterns, place names)
 * and Overpass is not SQL — injection is not the threat model — but quoting
 * keeps regex literals with commas (`"foo,bar"`) from confusing the parser.
 */
function escapeString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
