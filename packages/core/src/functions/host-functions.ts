import { Result } from "better-result";
import type { NominatimClient, NominatimResult } from "../clients/nominatim.ts";
import { NOMINATIM_BUSY_MESSAGE } from "../clients/nominatim.ts";
import type { OverpassClient, OverpassElement } from "../clients/overpass.ts";
import { OVERPASS_BUSY_MESSAGE, getElementCoords } from "../clients/overpass.ts";
import { isBrand, resolveBrand } from "./find-features-brands.ts";
import { resolveType, type TagClause, type ResolvedType } from "./find-features-types.ts";
import {
	generateOverpassQuery,
	validateOverpassQL,
	type ResolvedArea,
} from "./find-features-query.ts";
import { boundsAreaKm2, expandBounds, computeBounds, type Bounds } from "./geometry.ts";
import { haversineMeters } from "./haversine.ts";
import { compileWhere, applyTagsFilter, applySortBy } from "./filter-logic.ts";
import {
	computeDiagnosis,
	type Diagnosis,
	type ResolvedKind,
	type ResolvedPlace,
} from "./diagnosis.ts";

export interface HostContext {
	nominatim: NominatimClient;
	overpass: OverpassClient;
	signal?: AbortSignal;
}

export interface Feature {
	id: string;
	name?: string;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
	type?: string;
}

export interface GeocodeResult {
	id: string;
	name?: string;
	lat: number;
	lon: number;
	type?: string;
	importance?: number;
	display_name: string;
	bbox?: [number, number, number, number];
	alternatives?: Omit<GeocodeResult, "alternatives">[];
}

export interface FindFeaturesResult {
	features: Feature[];
	count: number;
	truncated: boolean;
	/** Present when count == 0: names the likely-failed dimension and suggests a retry. */
	diagnosis?: Diagnosis;
}

export interface SpatialPair {
	point: Feature;
	target: Feature;
	distance: number;
}

/** Unified fetch-envelope shape for the fetch primitives (search, find_features,
 *  overpass_query): the features actually returned, their count (always
 *  len(features)), and whether the source had more than the display limit. */
export interface FeaturesEnvelope {
	features: Feature[];
	count: number;
	truncated: boolean;
}

export interface DisplayData {
	markers?: { lat: number; lon: number; label?: string }[];
	features?: Feature[];
	pairs?: SpatialPair[];
	bounds?: Bounds;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_PAIRS = 1000;

/** Geocode a place name via Nominatim. Returns the top hit (with up to 3 alternatives) or null. */
export async function geocodeHost(ctx: HostContext, query: string): Promise<GeocodeResult | null> {
	const result = await ctx.nominatim.search(query, { limit: 5 }, ctx.signal);
	if (Result.isError(result)) {
		if (result.error._tag === "NominatimBusy") throw new Error(NOMINATIM_BUSY_MESSAGE);
		throw new Error(result.error.message);
	}
	const hits = result.value;
	if (hits.length === 0) return null;
	const top = hits[0]!;
	return nominatimToGeocodeResult(top, hits.slice(1, 4));
}

/** Reverse-geocode coordinates via Nominatim. Returns an array (0 or 1 entries). */
export async function reverseGeocodeHost(
	ctx: HostContext,
	lat: number,
	lon: number,
): Promise<GeocodeResult[]> {
	const result = await ctx.nominatim.reverse(lat, lon, { zoom: 18 }, ctx.signal);
	if (Result.isError(result)) {
		if (result.error._tag === "NominatimBusy") throw new Error(NOMINATIM_BUSY_MESSAGE);
		throw new Error(result.error.message);
	}
	if (!result.value) return [];
	return [nominatimToGeocodeResult(result.value)];
}

interface FindFeaturesParams {
	types?: string[];
	tags?: { key: string; value?: string; op?: string }[];
	area: {
		place?: string;
		bounds?: Bounds;
		around?: { lat: number; lon: number; radius: number };
		features?: Feature[];
	};
	name?: string;
	limit?: number;
}

/**
 * Search OSM features via Overpass. On zero results, attaches a `diagnosis`
 * naming the likely-failed dimension (misspelled type, ambiguous place) and
 * suggesting a concrete retry — the "did you mean?" pattern. No auto-broadening:
 * a 0-result is the model's signal to reformulate, and silent multi-pass retries
 * hide the model's mistake.
 */
export async function findFeaturesHost(
	ctx: HostContext,
	params: FindFeaturesParams,
): Promise<FindFeaturesResult> {
	const { nominatim, overpass, signal } = ctx;
	const resolved = resolveGroups(params.types, params.tags);
	if (!resolved) {
		throw new Error("Provide at least one of 'types' or 'tags'.");
	}
	const { area, place } = await resolveArea(nominatim, params.area, signal);
	const limit = params.limit ?? DEFAULT_LIMIT;

	const tryQuery = async (groups: TagClause[][], queryArea: ResolvedArea): Promise<Feature[]> => {
		const query = generateOverpassQuery({
			groups,
			...(params.name ? { nameRegex: params.name } : {}),
			area: queryArea,
			// Fetch one more than the display limit so Overpass (which respects
			// `out N`) can signal "there are more" — `formatFeatures` detects the
			// overflow and sets `truncated`. Requesting exactly `limit` made the
			// flag dead code: Overpass capped at `limit`, so the >limit check was
			// always false.
			limit: limit + 1,
		});
		const validation = validateOverpassQL(query, queryArea);
		if (!validation.valid) {
			throw new Error(`Invalid Overpass query: ${validation.errors.join("; ")}`);
		}
		const result = await overpass.query(query, signal);
		if (Result.isError(result)) {
			if (result.error._tag === "OverpassBusy") throw new Error(OVERPASS_BUSY_MESSAGE);
			throw new Error(result.error.message);
		}
		return elementsToFeatures(result.value.elements ?? []);
	};

	const features = await tryQuery(resolved.groups, area);
	if (features.length > 0) {
		return formatFeatures(features, limit);
	}
	// 0-results: a measurement, not a failure. Diagnose from data already in
	// hand (resolved type kinds + the geocoded place metadata) — no extra network.
	const diagnosis = computeDiagnosis({ resolvedKinds: resolved.resolvedKinds, place });
	return formatFeatures([], limit, diagnosis);
}

interface FilterParams {
	where?: string;
	tags?: { key: string; value?: string; op?: string }[];
	sort_by?: string;
	limit?: number;
	distinct?: boolean;
}

/** In-memory filter over a feature list using a where-expression, tag filters, sort, limit, and dedup. */
export function filterHost(features: Feature[], params: FilterParams): Feature[] {
	let result = features;
	if (params.where) {
		const predicate = compileWhere(params.where);
		result = result.filter(predicate);
	}
	if (params.tags && params.tags.length > 0) {
		result = applyTagsFilter(result, params.tags);
	}
	if (params.distinct) {
		const seen = new Set<string>();
		result = result.filter((el) => {
			if (seen.has(el.id)) return false;
			seen.add(el.id);
			return true;
		});
	}
	if (params.sort_by) result = applySortBy(result, params.sort_by);
	if (params.limit !== undefined) result = result.slice(0, params.limit);
	return result;
}

interface SpatialJoinParams {
	points: Feature[];
	targets: Feature[];
	operation: "near" | "nearest";
	radius: number;
}

/** Haversine join: `near` (all targets within radius of each point) or `nearest` (closest target per point). */
export function spatialJoinHost(params: SpatialJoinParams): SpatialPair[] {
	const points = params.points.filter((f) => f.lat !== undefined && f.lon !== undefined);
	const targets = params.targets.filter((f) => f.lat !== undefined && f.lon !== undefined);
	const maxPairs = DEFAULT_MAX_PAIRS;

	if (params.operation === "nearest") {
		const pairs: SpatialPair[] = [];
		for (const point of points) {
			let best: SpatialPair | null = null;
			for (const target of targets) {
				const dist = haversineMeters(point.lat!, point.lon!, target.lat!, target.lon!);
				if (dist <= params.radius && (best === null || dist < best.distance)) {
					best = { point, target, distance: Math.round(dist) };
				}
			}
			if (best) pairs.push(best);
		}
		return pairs;
	}

	const pairs: SpatialPair[] = [];
	for (const point of points) {
		for (const target of targets) {
			const dist = haversineMeters(point.lat!, point.lon!, target.lat!, target.lon!);
			if (dist <= params.radius) {
				pairs.push({ point, target, distance: Math.round(dist) });
				if (pairs.length >= maxPairs) return pairs;
			}
		}
	}
	return pairs;
}

/** Run a raw Overpass QL query and return features. Escape hatch — prefer find_featuresHost. Returns the same envelope shape as the other fetch primitives: `features`, `count` (== len(features)), and `truncated` (always false — the raw QL string's `out N` limit is inside the query text, unparsed by the executor, so truncation cannot be detected here). */
export async function overpassQueryHost(
	ctx: HostContext,
	query: string,
): Promise<{
	features: Feature[];
	count: number;
	truncated: boolean;
}> {
	const result = await ctx.overpass.query(query, ctx.signal);
	if (Result.isError(result)) {
		if (result.error._tag === "OverpassBusy") throw new Error(OVERPASS_BUSY_MESSAGE);
		throw new Error(result.error.message);
	}
	const features = elementsToFeatures(result.value.elements ?? []);
	return { features, count: features.length, truncated: false };
}

/**
 * Free-text Nominatim `/search` fetch — relevance-ranked fuzzy POI discovery,
 * a *different capability* from `find_features` (exhaustive structural tag-match
 * via Overpass). `truncated` is heuristic (`count >= requested_limit`): the
 * public Nominatim cap is ≤40, so hitting the limit means the answer is partial
 * and `find_features` may be needed for exhaustiveness.
 *
 * Nominatim returns no arbitrary OSM tags, so results carry no `tags` —
 * `filter(where=...)` on `search` results is limited to `name` comparisons.
 */
export async function searchHost(
	ctx: HostContext,
	query: string,
	limit = 40,
): Promise<FeaturesEnvelope> {
	const result = await ctx.nominatim.search(query, { limit }, ctx.signal);
	if (Result.isError(result)) {
		if (result.error._tag === "NominatimBusy") throw new Error(NOMINATIM_BUSY_MESSAGE);
		throw new Error(result.error.message);
	}
	const features = result.value.map(nominatimToFeature);
	return { features, count: features.length, truncated: features.length >= limit };
}

/** Map a Nominatim hit to the canonical Feature. Derives `id` from osm type/id,
 *  `type` from class/type, and parses the string coordinates. No `tags` —
 *  Nominatim does not return arbitrary OSM tags. */
function nominatimToFeature(r: NominatimResult): Feature {
	const id =
		r.osm_type && r.osm_id !== undefined ? `${r.osm_type}/${r.osm_id}` : `place/${r.place_id}`;
	const type = r.class && r.type ? `${r.class}/${r.type}` : (r.class ?? r.type);
	return {
		id,
		lat: Number(r.lat),
		lon: Number(r.lon),
		...(r.name ? { name: r.name } : {}),
		...(type ? { type } : {}),
	};
}

/** Map a raw Nominatim hit to the canonical GeocodeResult. Extracts bbox and up to 3 alternatives. */
function nominatimToGeocodeResult(hit: NominatimResult, alts?: NominatimResult[]): GeocodeResult {
	const id =
		hit.osm_type && hit.osm_id !== undefined
			? `${hit.osm_type}/${hit.osm_id}`
			: `place/${hit.place_id}`;
	const bbox: [number, number, number, number] | undefined = hit.boundingbox
		? [
				Number(hit.boundingbox[0]),
				Number(hit.boundingbox[2]),
				Number(hit.boundingbox[1]),
				Number(hit.boundingbox[3]),
			]
		: undefined;
	return {
		id,
		...(hit.name ? { name: hit.name } : {}),
		lat: Number(hit.lat),
		lon: Number(hit.lon),
		...(hit.type ? { type: hit.type } : {}),
		display_name: hit.display_name,
		...(bbox ? { bbox } : {}),
		...(alts && alts.length > 0
			? { alternatives: alts.map((a) => nominatimToGeocodeResult(a)) }
			: {}),
	};
}

interface ResolvedGroups {
	groups: TagClause[][];
	resolvedKinds: ResolvedKind[];
}

/** Classify each `types` entry as brand / known-type / name-fallback, expand to OR-groups, AND with explicit `tags`. Returns null when nothing to query. */
function resolveGroups(
	types: string[] | undefined,
	tags: { key: string; value?: string; op?: string }[] | undefined,
): ResolvedGroups | null {
	const explicitTagClauses = (tags ?? []).map((t) => ({
		key: t.key,
		...(t.value !== undefined ? { value: t.value } : {}),
		...(t.op ? { op: t.op as TagClause["op"] } : {}),
	}));
	const groups: TagClause[][] = [];
	const resolvedKinds: ResolvedKind[] = [];

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

/** Escape regex metacharacters for safe Overpass interpolation. Prevents invalid-regex rejections from model-supplied strings. */
function escapeRegexForOverpass(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve an area spec to a spatial clause, retaining the geocoded place's metadata (Level 1 diagnosis) when `area` was a `place`. Accepts `bounds`, `around`, `features` (derives bbox), or `place` (geocodes up to 5 hits so alternatives are available). */
async function resolveArea(
	nominatim: NominatimClient,
	area: FindFeaturesParams["area"],
	signal?: AbortSignal,
): Promise<{ area: ResolvedArea; place?: ResolvedPlace }> {
	if (area.bounds) return { area: { kind: "bbox", bounds: area.bounds } };
	if (area.around) {
		return {
			area: {
				kind: "around",
				lat: area.around.lat,
				lon: area.around.lon,
				radius: area.around.radius,
			},
		};
	}
	if (area.features && area.features.length > 0) {
		const bounds = computeBounds(area.features);
		if (!bounds) throw new Error("Cannot derive area from features without coordinates.");
		return { area: { kind: "bbox", bounds: expandBounds(bounds, 250) } };
	}
	if (area.place) {
		// Fetch up to 5 hits so the alternatives are available for diagnosis
		// ("did you mean Athens, Greece?") without a second round-trip.
		const result = await nominatim.search(area.place, { limit: 5 }, signal);
		if (Result.isError(result)) {
			if (result.error._tag === "NominatimBusy") throw new Error(NOMINATIM_BUSY_MESSAGE);
			throw new Error(result.error.message);
		}
		const hits = result.value;
		const hit = hits[0];
		if (!hit) throw new Error(`Place '${area.place}' did not geocode to any result.`);
		const place: ResolvedPlace = {
			// `display_name` is always present and disambiguates which hit was
			// picked ("Athens, Georgia, United States"), unlike `name` ("Athens").
			name: hit.display_name,
			alternatives: hits.slice(1).map((h) => h.display_name),
		};
		if (hit.boundingbox) {
			const [s = 0, n = 0, w = 0, e = 0] = hit.boundingbox.map(Number);
			const bounds = { minlat: s, minlon: w, maxlat: n, maxlon: e };
			return {
				area: { kind: "bbox", bounds },
				place: { ...place, sizeKm2: boundsAreaKm2(bounds) },
			};
		}
		return {
			area: { kind: "around", lat: Number(hit.lat), lon: Number(hit.lon), radius: 5000 },
			place,
		};
	}
	throw new Error("area must specify one of: place, bounds, around, features.");
}

/** Map raw Overpass elements to the canonical Feature shape, hoisting `name` from tags. */
function elementsToFeatures(elements: OverpassElement[]): Feature[] {
	const features: Feature[] = [];
	for (const el of elements) {
		const coord = getElementCoords(el);
		const tags: Record<string, string> = {};
		let name: string | undefined;
		if (el.tags) {
			for (const [k, v] of Object.entries(el.tags)) {
				if (k === "name") name = v;
				else tags[k] = v;
			}
		}
		features.push({
			id: `${el.type}/${el.id}`,
			...(coord ? { lat: coord.lat, lon: coord.lon } : {}),
			...(name ? { name } : {}),
			...(Object.keys(tags).length > 0 ? { tags } : {}),
		});
	}
	return features;
}

/** Package a feature list into the result shape. Truncates beyond `limit`, marks as `truncated` when the source held more than `limit` (detected because the query requested `limit + 1`). `count` is always `len(features)` — the count actually returned, never the pre-slice input. */
function formatFeatures(
	features: Feature[],
	limit: number,
	diagnosis: Diagnosis | undefined = undefined,
): FindFeaturesResult {
	const truncated = features.length > limit;
	const shown = truncated ? features.slice(0, limit) : features;
	return {
		features: shown,
		count: shown.length,
		truncated,
		...(diagnosis ? { diagnosis } : {}),
	};
}
