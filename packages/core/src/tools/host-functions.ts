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
import { expandBounds, computeBounds, type Bounds } from "./stored-element.ts";
import { haversineMeters } from "./tool-spatial-join.ts";
import { compileWhere, applyTagsFilter, applySortBy } from "./filter-logic.ts";

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
	relaxed: boolean;
	note?: string;
}

export interface SpatialPair {
	point: Feature;
	target: Feature;
	distance: number;
}

export interface DisplayData {
	markers?: { lat: number; lon: number; label?: string }[];
	features?: Feature[];
	pairs?: SpatialPair[];
	bounds?: Bounds;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_PAIRS = 1000;

/** Geocode a place name via Nominatim. Returns the top hit (with up to 4 alternatives) or null. */
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
 * Search OSM features via Overpass. On zero results, auto-relaxes:
 * expands radius (1.5x, 2x, 3x), broadens `eq` to `iregex` tags,
 * then drops the most restrictive OR-groups.
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
	const area = await resolveArea(nominatim, params.area, signal);
	const limit = params.limit ?? DEFAULT_LIMIT;

	const tryQuery = async (groups: TagClause[][], queryArea: ResolvedArea): Promise<Feature[]> => {
		const query = generateOverpassQuery({
			groups,
			...(params.name ? { nameRegex: params.name } : {}),
			area: queryArea,
			limit,
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

	let features = await tryQuery(resolved.groups, area);
	if (features.length > 0) {
		return formatFeatures(features, limit, false, undefined);
	}

	const relaxed = await applyRelaxation(tryQuery, resolved.groups, area);
	if (relaxed.features.length > 0 || relaxed.exhausted) {
		return formatFeatures(relaxed.features, limit, true, relaxed.note);
	}
	return formatFeatures([], limit, false, undefined);
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
	let elements = features.map(featureToStoredElement);
	if (params.where) {
		const predicate = compileWhere(params.where);
		elements = elements.filter(predicate);
	}
	if (params.tags && params.tags.length > 0) {
		elements = applyTagsFilter(elements, params.tags);
	}
	if (params.distinct) {
		const seen = new Set<string>();
		elements = elements.filter((el) => {
			if (seen.has(el.id)) return false;
			seen.add(el.id);
			return true;
		});
	}
	if (params.sort_by) elements = applySortBy(elements, params.sort_by);
	if (params.limit !== undefined) elements = elements.slice(0, params.limit);
	return elements.map(storedElementToFeature);
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

/** Run a raw Overpass QL query and return features. Escape hatch — prefer find_featuresHost. */
export async function overpassQueryHost(
	ctx: HostContext,
	query: string,
): Promise<{
	elements: Feature[];
	count: number;
}> {
	const result = await ctx.overpass.query(query, ctx.signal);
	if (Result.isError(result)) {
		if (result.error._tag === "OverpassBusy") throw new Error(OVERPASS_BUSY_MESSAGE);
		throw new Error(result.error.message);
	}
	const features = elementsToFeatures(result.value.elements ?? []);
	return { elements: features, count: features.length };
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
	resolvedKinds: { input: string; kind: "type" | "brand" | "name" }[];
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

/** Escape regex metacharacters for safe Overpass interpolation. Prevents invalid-regex rejections from model-supplied strings. */
function escapeRegexForOverpass(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve an area spec to a ResolvedArea. Accepts `bounds`, `around`, `features` (derives bbox), or `place` (geocodes). */
async function resolveArea(
	nominatim: NominatimClient,
	area: FindFeaturesParams["area"],
	signal?: AbortSignal,
): Promise<ResolvedArea> {
	if (area.bounds) return { kind: "bbox", bounds: area.bounds };
	if (area.around) {
		return {
			kind: "around",
			lat: area.around.lat,
			lon: area.around.lon,
			radius: area.around.radius,
		};
	}
	if (area.features && area.features.length > 0) {
		const elements = area.features.map(featureToStoredElement);
		const bounds = computeBounds(elements);
		if (!bounds) throw new Error("Cannot derive area from features without coordinates.");
		return { kind: "bbox", bounds: expandBounds(bounds, 250) };
	}
	if (area.place) {
		const result = await nominatim.search(area.place, { limit: 1 }, signal);
		if (Result.isError(result)) {
			if (result.error._tag === "NominatimBusy") throw new Error(NOMINATIM_BUSY_MESSAGE);
			throw new Error(result.error.message);
		}
		const hit = result.value[0];
		if (!hit) throw new Error(`Place '${area.place}' did not geocode to any result.`);
		if (hit.boundingbox) {
			const [s = 0, n = 0, w = 0, e = 0] = hit.boundingbox.map(Number);
			return { kind: "bbox", bounds: { minlat: s, minlon: w, maxlat: n, maxlon: e } };
		}
		return {
			kind: "around",
			lat: Number(hit.lat),
			lon: Number(hit.lon),
			radius: 5000,
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

/** Package a feature list into the result shape. Truncates beyond `limit`, marks as `relaxed` when auto-broadening was applied. */
function formatFeatures(
	features: Feature[],
	limit: number,
	relaxed: boolean,
	note: string | undefined,
): FindFeaturesResult {
	const truncated = features.length > limit;
	const shown = truncated ? features.slice(0, limit) : features;
	return {
		features: shown,
		count: features.length,
		truncated,
		relaxed,
		...(note ? { note } : {}),
	};
}

/**
 * Multi-pass relaxation when an Overpass query returns zero results.
 * Tries in order: expand around-radius (1.5x, 2x, 3x), broaden `eq`
 * tag clauses to `iregex`, drop the most restrictive OR-groups.
 */
async function applyRelaxation(
	tryQuery: (groups: TagClause[][], area: ResolvedArea) => Promise<Feature[]>,
	groups: TagClause[][],
	area: ResolvedArea,
): Promise<{ features: Feature[]; note?: string; exhausted: boolean }> {
	if (area.kind === "around") {
		const original = area.radius;
		for (const mult of [1.5, 2, 3]) {
			const expanded: ResolvedArea = { ...area, radius: Math.round(original * mult) };
			const features = await tryQuery(groups, expanded);
			if (features.length > 0) {
				return {
					features,
					note: `expanded radius from ${original}m to ${expanded.radius}m`,
					exhausted: false,
				};
			}
		}
	}
	const broadened = broadenTags(groups);
	if (broadened) {
		const features = await tryQuery(broadened, area);
		if (features.length > 0) {
			return { features, note: "broadened tag filters", exhausted: false };
		}
	}
	const dropped = dropMostRestrictive(groups);
	if (dropped && dropped.length > 0) {
		const features = await tryQuery(dropped, area);
		if (features.length > 0) {
			return { features, note: "dropped most restrictive tag clause", exhausted: false };
		}
	}
	return { features: [], note: undefined, exhausted: true };
}

/** Convert `eq` tag clauses to case-insensitive `iregex`. Returns null when no clauses to broaden. */
function broadenTags(groups: TagClause[][]): TagClause[][] | null {
	let changed = false;
	const result = groups.map((group) =>
		group.map((c) => {
			if (c.op === "eq" && c.value) {
				changed = true;
				return { ...c, op: "iregex" as const };
			}
			return c;
		}),
	);
	return changed ? result : null;
}

/** Drop the most restrictive OR-groups (those with the most clauses). Keeps top half; returns null when there's ≤1 group. */
function dropMostRestrictive(groups: TagClause[][]): TagClause[][] | null {
	if (groups.length <= 1) return null;
	const sorted = [...groups].sort((a, b) => b.length - a.length);
	return sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
}

/** Convert a Feature to StoredElement (re-injects name into tags so filter predicates resolve). */
function featureToStoredElement(f: Feature): import("./schemas.ts").StoredElement {
	const tags: Record<string, string> = { ...f.tags };
	if (f.name) tags.name = f.name;
	return {
		id: f.id,
		...(f.lat !== undefined && f.lon !== undefined ? { lat: f.lat, lon: f.lon } : {}),
		...(f.name ? { name: f.name } : {}),
		...(Object.keys(tags).length > 0 ? { tags } : {}),
	};
}

/** Convert a StoredElement back to Feature (strips the type field, spreads tags). */
function storedElementToFeature(el: import("./schemas.ts").StoredElement): Feature {
	return {
		id: el.id,
		...(el.lat !== undefined ? { lat: el.lat } : {}),
		...(el.lon !== undefined ? { lon: el.lon } : {}),
		...(el.name ? { name: el.name } : {}),
		...(el.tags ? { tags: { ...el.tags } } : {}),
	};
}
