import { Result } from "better-result";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { NominatimClient, NominatimResult } from "../clients/nominatim.ts";
import { NOMINATIM_BUSY_MESSAGE } from "../clients/nominatim.ts";
import type { OverpassClient, OverpassElement } from "../clients/overpass.ts";
import { formatElement, OVERPASS_BUSY_MESSAGE } from "../clients/overpass.ts";
import {
	FindFeaturesToolDetailsSchema,
	type FindFeaturesToolDetails,
	type OverpassResultEntry,
	TagClauseSchema,
} from "./schemas.ts";
import type { ToolProgress } from "./progress.ts";
import { defineTool, parseSchema } from "./tool-module.ts";
import { textResult, formatContentLines } from "./content.ts";
import { throwIfAborted, forwardProgress, recoverBusyOrThrow } from "./control-flow.ts";
import { isBrand, resolveBrand } from "./find-features-brands.ts";
import { resolveType, type TagClause, type ResolvedType } from "./find-features-types.ts";
import {
	generateOverpassQuery,
	validateOverpassQL,
	type ResolvedArea,
} from "./find-features-query.ts";
import {
	overpassEntryToStored,
	overpassElementToResultEntry,
	expandBounds,
	computeBounds,
	type Bounds,
	type StoredElement,
} from "./stored-element.ts";
import type { DependencyContext } from "./dependency-graph.ts";
import { resolveRef } from "./dependency-graph.ts";
import type { StoredResult } from "./result-store.ts";

const boundsSchema = Type.Object({
	minlat: Type.Number(),
	minlon: Type.Number(),
	maxlat: Type.Number(),
	maxlon: Type.Number(),
});

// tagClauseSchema is shared with filter via schemas.ts (TagClauseSchema) —
// keep the two surfaces byte-identical so the model can reuse expressions.
const tagClauseSchema = TagClauseSchema;

const schema = Type.Object({
	area: Type.Object({
		place: Type.Optional(
			Type.String({
				description:
					"Place name to geocode and use as the search centre, e.g. 'Stockholm, Sweden' or 'Camden, London'.",
			}),
		),
		expand: Type.Optional(
			Type.String({
				description:
					'Distance to expand beyond the geocoded point when the place resolves to a point (not an area). Examples: "5km", "100km". Ignored for area-returning places (cities, countries). Defaults to "5km".',
			}),
		),
		bounds: Type.Optional(boundsSchema),
		around: Type.Optional(
			Type.Object({
				lat: Type.Number(),
				lon: Type.Number(),
				radius: Type.Number({ description: "Radius in metres." }),
			}),
		),
		queryRef: Type.Optional(
			Type.String({
				description:
					"Tool call ID of a prior result. The bounding box of that result's elements becomes the search area (with a small margin).",
			}),
		),
	}),
	types: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Human-readable feature types, e.g. "restaurant", "town", "LIDL". Multiple are OR\'d. Unknown types fall back to a case-insensitive name match. Brand names ("LIDL", "IKEA") use brand-tag matching with a name fallback.',
		}),
	),
	tags: Type.Optional(
		Type.Array(tagClauseSchema, {
			description:
				"Raw OSM tag filters (AND). Use for filtering not expressible via 'types'. Overpass cannot do numeric comparison reliably — fetch then filter in-memory with the 'filter' tool.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Case-insensitive regex applied to the OSM 'name' tag, in addition to types/tags. Example: '^starbucks'.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ minimum: 1, maximum: 10_000, description: "Maximum results. Default 500." }),
	),
	includeGeometry: Type.Optional(
		Type.Boolean({
			description:
				"If true, fetch full geometry for ways/relations (larger response). Default false (centre points only).",
		}),
	),
});

const DEFAULT_LIMIT = 500;
const DEFAULT_EXPAND_METERS = 5_000;

/** Sentinel thrown by helpers to signal a Nominatim-busy upstream; caught at execute top. */
class BusyMarker {
	readonly busy = true as const;
}

/** `find_features` context: the two OSM clients plus the dependency layer. */
export type FindFeaturesContext = DependencyContext & {
	nominatim: NominatimClient;
	overpass: OverpassClient;
};

/** Resolution outcome for the `types` + `tags` parameters. */
interface ResolvedGroups {
	groups: TagClause[][];
	resolvedKinds: { input: string; kind: "type" | "brand" | "name" }[];
}

/**
 * Build the OR-group list for the Overpass query from `types` + `tags`.
 *
 * Each `types` entry is classified as brand / type / name-fallback and
 * expanded to its OR-groups. Every group is then AND-ed with the explicit
 * `tags` clauses. When `types` is empty but `tags` is present, a single
 * group carries just the `tags` conjunction. Returns `null` when neither
 * is present — a filter-less query is unsafe (would return everything).
 */
function resolveGroups(
	types: string[] | undefined,
	tags: TagClause[] | undefined,
): ResolvedGroups | null {
	const explicitTagClauses = (tags ?? []).map((t) => ({
		key: t.key,
		...(t.value !== undefined ? { value: t.value } : {}),
		...(t.op ? { op: t.op } : {}),
	}));
	const groups: TagClause[][] = [];
	const resolvedKinds: { input: string; kind: "type" | "brand" | "name" }[] = [];

	for (const input of types ?? []) {
		const trimmed = input.trim();
		if (!trimmed) continue;
		if (isBrand(trimmed)) {
			for (const g of resolveBrand(trimmed)) groups.push([...g, ...explicitTagClauses]);
			resolvedKinds.push({ input: trimmed, kind: "brand" });
			continue;
		}
		const typeGroups: ResolvedType | null = resolveType(trimmed);
		if (typeGroups) {
			for (const g of typeGroups) groups.push([...g, ...explicitTagClauses]);
			resolvedKinds.push({ input: trimmed, kind: "type" });
			continue;
		}
		groups.push([
			{ key: "name", value: escapeRegexForOverpass(trimmed), op: "iregex" },
			...explicitTagClauses,
		]);
		resolvedKinds.push({ input: trimmed, kind: "name" });
	}

	if (groups.length === 0 && explicitTagClauses.length > 0) {
		groups.push([...explicitTagClauses]);
	}

	if (groups.length === 0) return null;
	return { groups, resolvedKinds };
}

/**
 * Escape regex metacharacters in a model-supplied type string before it's
 * used as the body of an Overpass iregex clause. The model can pass arbitrary
 * `types` strings; without escaping, `"foo(bar"` produces an invalid regex
 * that Overpass rejects with a generic remark.
 */
function escapeRegexForOverpass(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve the `area` parameter into a concrete {@link ResolvedArea} and the
 * bbox actually queried (for client map-fitting).
 *
 * `place` geocodes through Nominatim: an area-returning result (with
 * `boundingbox`) becomes a bbox; a point result becomes an `around` query
 * with the `expand` radius. `queryRef` resolves upstream and uses its
 * element bounds expanded by a small margin so edge features aren't clipped.
 */
async function resolveArea(
	ctx: FindFeaturesContext,
	toolCallId: string,
	area: Static<typeof schema>["area"],
	signal?: AbortSignal,
): Promise<{ area: ResolvedArea; queryArea: Bounds }> {
	const present = (["place", "bounds", "around", "queryRef"] as const).filter(
		(k) => area[k] !== undefined,
	);
	if (present.length === 0) {
		throw new Error(
			"find_features: area must specify exactly one of place, bounds, around, queryRef.",
		);
	}
	if (present.length > 1) {
		throw new Error(
			`find_features: area must specify exactly one kind, got ${present.join(", ")}.`,
		);
	}

	if (area.bounds) return { area: { kind: "bbox", bounds: area.bounds }, queryArea: area.bounds };
	if (area.around) {
		const q = aroundToBounds(area.around.lat, area.around.lon, area.around.radius);
		return {
			area: {
				kind: "around",
				lat: area.around.lat,
				lon: area.around.lon,
				radius: area.around.radius,
			},
			queryArea: q,
		};
	}
	if (area.queryRef) {
		const upstream = await resolveRef(ctx, toolCallId, area.queryRef, signal);
		const bounds = computeBounds(upstream.elements);
		if (!bounds) {
			throw new Error(
				`find_features: queryRef '${area.queryRef}' has no elements with coordinates; cannot derive a search area.`,
			);
		}
		const expanded = expandBounds(bounds, 250);
		return { area: { kind: "bbox", bounds: expanded }, queryArea: expanded };
	}

	const expandMeters = area.expand ? parseDistanceMeters(area.expand) : DEFAULT_EXPAND_METERS;
	const hit = await geocodeFirst(ctx.nominatim, area.place!, signal);
	if (hit?.boundingbox) {
		const [s = 0, n = 0, w = 0, e = 0] = hit.boundingbox.map(Number);
		const bounds = { minlat: s, minlon: w, maxlat: n, maxlon: e };
		return { area: { kind: "bbox", bounds }, queryArea: bounds };
	}
	if (hit) {
		const lat = Number(hit.lat);
		const lon = Number(hit.lon);
		return {
			area: { kind: "around", lat, lon, radius: expandMeters },
			queryArea: aroundToBounds(lat, lon, expandMeters),
		};
	}
	throw new Error(`find_features: place '${area.place}' did not geocode to any result.`);
}

/**
 * Resolve a `place` query to its first Nominatim hit. Nominatim-busy is
 * surfaced as a {@link BusyMarker} so the top-level execute folds it into
 * the same busy soft-failure shape the other data-source tools use.
 */
async function geocodeFirst(
	nominatim: NominatimClient,
	query: string,
	signal?: AbortSignal,
): Promise<NominatimResult | null> {
	const result = await nominatim.search(query, { limit: 1 }, signal);
	if (Result.isError(result)) {
		if (result.error._tag === "NominatimBusy") throw new BusyMarker();
		throw result.error;
	}
	return result.value[0] ?? null;
}

/** Approximate bbox of an `around:LAT,LON,RADIUS` query, for client map-fitting. */
function aroundToBounds(lat: number, lon: number, radiusMeters: number): Bounds {
	const dLat = radiusMeters / 111_000;
	const dLon = radiusMeters / (111_000 * Math.cos((lat * Math.PI) / 180));
	return { minlat: lat - dLat, minlon: lon - dLon, maxlat: lat + dLat, maxlon: lon + dLon };
}

/**
 * Parse a distance string ("5km", "1500m", "200") into metres. Suffix is
 * case-insensitive; bare numbers are metres. Returns 0 for an unparseable
 * value — `find_features` then falls back to the default expand.
 */
function parseDistanceMeters(s: string): number {
	const m = /^\s*(\d+(?:\.\d+)?)\s*(km|m)?\s*$/i.exec(s);
	if (!m) return 0;
	const n = Number(m[1]);
	return m[2]?.toLowerCase() === "km" ? n * 1_000 : n;
}

/** Convert Overpass elements to wire entries + stored elements in one pass. */
function toEntries(elements: OverpassElement[]): {
	data: OverpassResultEntry[];
	stored: StoredElement[];
} {
	const data: OverpassResultEntry[] = [];
	const stored: StoredElement[] = [];
	for (const el of elements) {
		const entry = overpassElementToResultEntry(el);
		data.push(entry);
		stored.push(overpassEntryToStored(entry));
	}
	return { data, stored };
}

export const findFeaturesModule = defineTool<
	{ kind: "find_features"; entries: OverpassResultEntry[] } | { kind: "find_features_busy" },
	FindFeaturesContext,
	typeof schema,
	ToolProgress | FindFeaturesToolDetails | { busy: true }
>({
	name: "find_features",
	label: "Find Features",
	description: `Primary spatial-data fetch. Searches OpenStreetMap for features matching human-readable types ("restaurant", "town", "LIDL") within a defined area, with optional raw-tag filters and a name regex. Results are stored and referenceable by subsequent filter / spatial_join / find_features calls in the same turn via the ref fields.

Area is exactly one of: place (geocoded), bounds (bbox), around (radius), or queryRef (bbox of a prior result). Always prefer this over query_osm; use query_osm only for queries this tool cannot express.

Numeric comparisons (population < 30000, ele > 1000) are NOT reliable in Overpass — fetch with this tool, then narrow with the filter tool.`,
	parameters: schema,
	detailsSchema: FindFeaturesToolDetailsSchema,
	parse: parseSchema(FindFeaturesToolDetailsSchema, (d) => {
		// Busy soft-failure: a separate result kind so count-derivation in
		// tools/index.ts can exclude it like the other busy shapes.
		if ((d as { busy?: true }).busy) return { kind: "find_features_busy" };
		return { kind: "find_features", entries: d.data };
	}),
	execute: async (ctx, toolCallId, params, signal, onUpdate) => {
		throwIfAborted(signal);
		const reg = ctx.coordinator.register(toolCallId);
		// Set on the success path; the finally resolves waiters with it (or
		// null + the thrown error on failure). `done` is idempotent.
		let stored: StoredResult | null = null;
		let pendingCause: unknown;
		try {
			const resolved = resolveGroups(params.types, params.tags);
			if (!resolved) {
				throw new Error(
					"find_features: provide at least one of 'types' or 'tags' — a filter-less query is unsafe.",
				);
			}
			const { area, queryArea } = await resolveArea(ctx, toolCallId, params.area, signal);

			const query = generateOverpassQuery({
				groups: resolved.groups,
				...(params.name ? { nameRegex: params.name } : {}),
				area,
				limit: params.limit ?? DEFAULT_LIMIT,
				...(params.includeGeometry ? { includeGeometry: true } : {}),
			});
			const validation = validateOverpassQL(query, area);
			if (!validation.valid) {
				throw new Error(
					`find_features generated an invalid Overpass query: ${validation.errors.join("; ")}`,
				);
			}

			onUpdate?.({ content: [], details: { type: "running" } });
			const result = await Result.gen(async function* () {
				const response = yield* Result.await(
					ctx.overpass.query(query, signal, { onProgress: forwardProgress(onUpdate) }),
				);
				const elements = response.elements ?? [];
				const { data, stored: storedElements } = toEntries(elements);
				stored = {
					toolCallId,
					toolName: "find_features",
					timestamp: Date.now(),
					elements: storedElements,
				};
				if (elements.length === 0) {
					return Result.ok({
						...textResult("No results."),
						details: {
							data: [] as OverpassResultEntry[],
							queryArea,
							resolvedTypes: resolved.resolvedKinds,
						},
					});
				}
				const text = formatContentLines(
					elements,
					formatElement,
					(rest) =>
						`…and ${rest} more results. All results are shown on the map; narrow with the filter tool or refine the area.`,
				);
				return Result.ok({
					...textResult(text),
					details: { data, queryArea, resolvedTypes: resolved.resolvedKinds },
				});
			});
			return recoverBusyOrThrow(result, "OverpassBusy", {
				...textResult(OVERPASS_BUSY_MESSAGE),
				details: { data: [], busy: true },
			});
		} catch (e) {
			if (e instanceof BusyMarker) {
				return { ...textResult(NOMINATIM_BUSY_MESSAGE), details: { data: [], busy: true } };
			}
			// Re-throw; the finally forwards the cause to downstream waiters.
			pendingCause = e;
			throw e;
		} finally {
			reg.done(stored, stored ? undefined : pendingCause);
		}
	},
});
