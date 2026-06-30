/// <reference types="bun" />
import { test, expect } from "bun:test";
import fc from "fast-check";
import { Result } from "better-result";
import type { NominatimClient } from "../clients/nominatim.ts";
import {
	NOMINATIM_BUSY_MESSAGE,
	NominatimBusyError,
	NominatimHttpError,
} from "../clients/nominatim.ts";
import type { OverpassClient } from "../clients/overpass.ts";
import {
	OVERPASS_BUSY_MESSAGE,
	OverpassBusyError,
	OverpassHttpError,
} from "../clients/overpass.ts";
import { haversineMeters } from "./haversine.ts";

import {
	filterHost,
	spatialJoinHost,
	geocodeHost,
	findFeaturesHost,
	searchHost,
	overpassQueryHost,
	type HostContext,
	type Feature,
} from "./host-functions.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type NominatimHit = {
	place_id: number;
	lat: string;
	lon: string;
	display_name: string;
	name?: string;
	type?: string;
	class?: string;
	osm_type?: "node" | "way" | "relation";
	osm_id?: number;
	boundingbox?: [string, string, string, string];
};

type OverpassEl = {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
};

function makeHit(overrides: Partial<NominatimHit> = {}): NominatimHit {
	return {
		place_id: 258761465,
		lat: "40.7127",
		lon: "-74.0059",
		display_name: "New York City, USA",
		osm_type: "relation",
		osm_id: 175905,
		boundingbox: ["40.477399", "40.916178", "-74.25909", "-73.700272"],
		...overrides,
	};
}

function makeEl(overrides: Partial<OverpassEl> = {}): OverpassEl {
	return {
		type: "node",
		id: 1,
		lat: 40.7127,
		lon: -74.0059,
		...overrides,
	};
}

function mockCtx(opts: {
	nominatim?: Partial<NominatimClient>;
	overpass?: Partial<OverpassClient>;
}): HostContext {
	return {
		nominatim: { search: () => {}, reverse: () => {}, ...opts.nominatim } as NominatimClient,
		overpass: { query: () => {}, ...opts.overpass } as OverpassClient,
	};
}

// ---------------------------------------------------------------------------
// filterHost
// ---------------------------------------------------------------------------
//
// The composed pipeline's universal laws, asserted for ANY features/params:
// (1) the result is a subset of the input by reference (filtering never
// invents elements — and this forces empty-input -> empty); (2) the whole
// pipeline (where -> tags -> distinct -> sort -> limit) is idempotent —
// filtering the filtered result is a no-op; (3) a non-negative limit bounds the
// length (forcing limit-0 -> empty). The `where` generator draws only from a
// grammar of compilable expressions. Specific filtering outcomes stay pinned by
// the examples below.

const whereKey = fc.constantFrom(
	"amenity",
	"population",
	"name",
	"ref",
	"level",
	"score",
	"region",
);
// Letter-leading so the tokenizer reads each value as a single ident token
// (a digit-leading "0A" would split into number+ident and fail to compile).
const bareword = fc
	.string({ minLength: 1, maxLength: 8 })
	.filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));

/** A single compilable comparison term. */
const whereTerm = fc.oneof(
	fc.tuple(whereKey, fc.constantFrom("=", "!="), bareword).map(([k, o, v]) => `${k} ${o} ${v}`),
	fc
		.tuple(whereKey, fc.constantFrom("<", "<=", ">", ">="), fc.integer({ min: -1000, max: 1000 }))
		.map(([k, o, v]) => `${k} ${o} ${v}`),
	fc.tuple(whereKey, fc.constantFrom("=~", "!~"), bareword).map(([k, o, v]) => `${k} ${o} /${v}/i`),
	fc.tuple(whereKey, fc.boolean()).map(([k, neg]) => `${k} IS ${neg ? "NOT NULL" : "NULL"}`),
);

/** A compilable where expression (a term, or two terms joined by AND/OR). */
const whereArb = fc.oneof(
	whereTerm,
	fc
		.tuple(whereTerm, fc.constantFrom("AND", "OR"), whereTerm)
		.map(([a, op, b]) => `${a} ${op} ${b}`),
);

const filterFeatureArb = fc
	.record({
		id: fc.string({ minLength: 1, maxLength: 6 }),
		name: fc.option(bareword),
		tags: fc
			.uniqueArray(fc.tuple(whereKey, bareword), { selector: ([k]) => k, maxLength: 4 })
			.map((entries) => Object.fromEntries(entries) as Record<string, string>),
	})
	.map((f) => ({
		id: f.id,
		...(f.name !== null ? { name: f.name } : {}),
		...(f.tags !== null && Object.keys(f.tags).length > 0 ? { tags: f.tags } : {}),
	}));

const filterTagsParamArb = fc.array(
	fc.record({
		key: whereKey,
		value: fc.option(bareword).map((v) => v ?? undefined),
		op: fc
			.option(fc.constantFrom("eq", "neq", "regex", "iregex", "exists", "notexists"))
			.map((v) => v ?? undefined),
	}),
	{ maxLength: 3 },
);

const filterParamsArb = fc.record({
	where: fc.option(whereArb).map((v) => v ?? undefined),
	tags: filterTagsParamArb,
	distinct: fc.boolean(),
	sort_by: fc
		.option(
			fc.oneof(
				whereKey,
				whereKey.map((k) => `-${k}`),
			),
		)
		.map((v) => v ?? undefined),
});

test("filterHost: result is a subset of the input by reference, for any features/params", () => {
	fc.assert(
		fc.property(
			fc.array(filterFeatureArb, { maxLength: 15 }),
			filterParamsArb,
			(features, params) => {
				const result = filterHost(features, params);
				return result.every((r) => features.includes(r));
			},
		),
	);
});

test("filterHost: idempotent — filtering the filtered result is a no-op, for any features/params", () => {
	fc.assert(
		fc.property(
			fc.array(filterFeatureArb, { maxLength: 15 }),
			filterParamsArb,
			(features, params) => {
				const once = filterHost(features, params);
				const twice = filterHost(once, params);
				return once.length === twice.length && once.every((e, i) => twice[i] === e);
			},
		),
	);
});

test("filterHost: a non-negative limit bounds the result length, for any features", () => {
	fc.assert(
		fc.property(
			fc.array(filterFeatureArb, { maxLength: 15 }),
			fc.integer({ min: 0, max: 20 }),
			(features, limit) => filterHost(features, { limit }).length <= limit,
		),
	);
});

test("filterHost — no params returns identity (same features)", () => {
	const features: Feature[] = [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	];
	expect(filterHost(features, {})).toEqual(features);
});

test("filterHost — filters by where expression", () => {
	const features: Feature[] = [
		{ id: "a", tags: { population: "50000" } },
		{ id: "b", tags: { population: "20000" } },
		{ id: "c", tags: { population: "10000" } },
	];
	const result = filterHost(features, { where: "population < 30000" });
	expect(result).toHaveLength(2);
	expect(result.map((f) => f.id)).toEqual(["b", "c"]);
});

test("filterHost — applies tag filters", () => {
	const features: Feature[] = [
		{ id: "a", tags: { amenity: "cafe", cuisine: "italian" } },
		{ id: "b", tags: { amenity: "restaurant" } },
		{ id: "c", tags: { amenity: "cafe", cuisine: "french" } },
	];
	const result = filterHost(features, {
		tags: [
			{ key: "amenity", value: "cafe", op: "eq" },
			{ key: "cuisine", op: "exists" },
		],
	});
	expect(result).toHaveLength(2);
	expect(result.map((f) => f.id)).toEqual(["a", "c"]);
});

test("filterHost — applies distinct dedup", () => {
	const features: Feature[] = [
		{ id: "a", name: "Alpha" },
		{ id: "a", name: "Alpha duplicate" },
		{ id: "b", name: "Beta" },
		{ id: "b", name: "Beta duplicate" },
		{ id: "c", name: "Gamma" },
	];
	const result = filterHost(features, { distinct: true });
	expect(result).toHaveLength(3);
	expect(result.map((f) => f.id)).toEqual(["a", "b", "c"]);
});

test("filterHost — applies sortBy with '-' prefix (descending)", () => {
	const features: Feature[] = [
		{ id: "a", tags: { rank: "2" } },
		{ id: "b", tags: { rank: "10" } },
		{ id: "c", tags: { rank: "1" } },
	];
	const result = filterHost(features, { sort_by: "-rank" });
	expect(result.map((f) => f.id)).toEqual(["b", "a", "c"]);
});

test("filterHost — applies sortBy ascending (default)", () => {
	const features: Feature[] = [
		{ id: "a", tags: { level: "3" } },
		{ id: "b", tags: { level: "1" } },
		{ id: "c", tags: { level: "2" } },
	];
	const result = filterHost(features, { sort_by: "level" });
	expect(result.map((f) => f.id)).toEqual(["b", "c", "a"]);
});

test("filterHost — applies limit", () => {
	const features: Feature[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
	expect(filterHost(features, { limit: 3 })).toHaveLength(3);
});

test("filterHost — chains where + sort_by + limit", () => {
	const features: Feature[] = [
		{ id: "a", tags: { score: "5", region: "east" } },
		{ id: "b", tags: { score: "9", region: "west" } },
		{ id: "c", tags: { score: "3", region: "east" } },
		{ id: "d", tags: { score: "7", region: "east" } },
	];
	const result = filterHost(features, {
		where: "region = east",
		sort_by: "-score",
		limit: 2,
	});
	expect(result.map((f) => f.id)).toEqual(["d", "a"]);
});

// ---------------------------------------------------------------------------
// spatialJoinHost (property-based)
// ---------------------------------------------------------------------------
// The contract, asserted for ANY points/targets/radius: coord-less features
// never appear in output; every pair's recomputed haversine is ≤ radius (the
// inclusion oracle — independent of the rounded `distance` field) and its
// `distance` is exactly round(haversine); `near` is capped at 1000 pairs; and
// `nearest` emits at most one pair per point. haversineMeters (already
// property-tested) is the distance oracle.

/** Feature with independently-optional lat/lon (some carry only one axis). */
const coordFeatureArb = fc
	.record({
		id: fc.string({ minLength: 1, maxLength: 8 }),
		lat: fc.option(fc.float({ min: -90, max: 90, noNaN: true })),
		lon: fc.option(fc.float({ min: -180, max: 180, noNaN: true })),
	})
	.map((f) => ({
		id: f.id,
		...(f.lat !== null ? { lat: f.lat } : {}),
		...(f.lon !== null ? { lon: f.lon } : {}),
	}));

const radiusArb = fc.float({ min: 0, max: 1_000_000, noNaN: true });

const hasCoords = (f: Feature) => f.lat !== undefined && f.lon !== undefined;

test("spatialJoinHost (near): pairs are within radius, coord-bearing, distance is round(haversine), and empty inputs yield empty, for any inputs", () => {
	fc.assert(
		fc.property(
			fc.array(coordFeatureArb),
			fc.array(coordFeatureArb),
			radiusArb,
			(points, targets, radius) => {
				const result = spatialJoinHost({ points, targets, operation: "near", radius });
				if (!points.some(hasCoords) || !targets.some(hasCoords)) {
					return result.length === 0;
				}
				return (
					result.length <= 1000 &&
					result.every((p) => {
						const raw = haversineMeters(p.point.lat!, p.point.lon!, p.target.lat!, p.target.lon!);
						return (
							raw <= radius &&
							p.distance === Math.round(raw) &&
							hasCoords(p.point) &&
							hasCoords(p.target)
						);
					})
				);
			},
		),
	);
});

test("spatialJoinHost (nearest): at most one pair per point, each within radius and coord-bearing, for any inputs", () => {
	fc.assert(
		fc.property(
			fc.array(coordFeatureArb),
			fc.array(coordFeatureArb),
			radiusArb,
			(points, targets, radius) => {
				const result = spatialJoinHost({ points, targets, operation: "nearest", radius });
				if (!points.some(hasCoords) || !targets.some(hasCoords)) {
					return result.length === 0;
				}
				const seen = new Set<Feature>();
				for (const p of result) {
					const raw = haversineMeters(p.point.lat!, p.point.lon!, p.target.lat!, p.target.lon!);
					if (raw > radius || p.distance !== Math.round(raw)) return false;
					if (!hasCoords(p.point) || !hasCoords(p.target)) return false;
					if (seen.has(p.point)) return false;
					seen.add(p.point);
				}
				return true;
			},
		),
	);
});

test("spatialJoinHost — respects DEFAULT_MAX_PAIRS = 1000", () => {
	// Create 1 point and 2000 targets — all within radius, should cap at 1000
	const points: Feature[] = [{ id: "p1", lat: 50, lon: 10 }];
	const targets: Feature[] = Array.from({ length: 2000 }, (_, i) => ({
		id: `t${i}`,
		lat: 50 + (i % 100) * 0.00001,
		lon: 10 + Math.floor(i / 100) * 0.00001,
	}));
	const result = spatialJoinHost({ points, targets, operation: "near", radius: 1_000_000 });
	expect(result.length).toBe(1000);
});

// ---------------------------------------------------------------------------
// geocodeHost
// ---------------------------------------------------------------------------

test("geocodeHost — successful geocode returns GeocodeResult", async () => {
	const hit = makeHit({ name: "New York" });
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.ok([hit])),
		},
	});
	const result = await geocodeHost(ctx, "New York");
	expect(result).not.toBeNull();
	expect(result!.name).toBe("New York");
	expect(result!.lat).toBe(40.7127);
	expect(result!.lon).toBe(-74.0059);
	expect(result!.id).toBe("relation/175905");
	expect(result!.display_name).toBe("New York City, USA");
	expect(result!.bbox).toEqual([40.477399, -74.25909, 40.916178, -73.700272]);
});

test("geocodeHost — no results returns null", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.ok([])),
		},
	});
	const result = await geocodeHost(ctx, "nowhere");
	expect(result).toBeNull();
});

test("geocodeHost — NominatimBusy error throws with busy message", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.err(new NominatimBusyError({ status: 429 }))),
		},
	});
	await expect(geocodeHost(ctx, "anywhere")).rejects.toThrow(NOMINATIM_BUSY_MESSAGE);
});

test("geocodeHost — non-busy errors throw the original TaggedError (preserve _tag/cause)", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.err(new NominatimHttpError({ message: "Bad request" }))),
		},
	});
	await expect(geocodeHost(ctx, "anywhere")).rejects.toThrow("Bad request");
	await expect(geocodeHost(ctx, "anywhere")).rejects.toBeInstanceOf(NominatimHttpError);
	await expect(geocodeHost(ctx, "anywhere")).rejects.toMatchObject({ _tag: "NominatimHttp" });
});

test("geocodeHost — alternatives are populated from extra hits", async () => {
	const top = makeHit({
		place_id: 1,
		name: "Springfield, IL",
		lat: "39.7817",
		lon: "-89.6501",
		display_name: "Springfield, Illinois",
		boundingbox: undefined,
	});
	const alt1 = makeHit({
		place_id: 2,
		name: "Springfield, MO",
		lat: "37.2089",
		lon: "-93.2923",
		display_name: "Springfield, Missouri",
		osm_type: undefined,
		osm_id: undefined,
		boundingbox: undefined,
	});
	const alt2 = makeHit({
		place_id: 3,
		name: "Springfield, OR",
		lat: "44.0462",
		lon: "-123.0220",
		display_name: "Springfield, Oregon",
		boundingbox: undefined,
	});
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.ok([top, alt1, alt2])),
		},
	});
	const result = await geocodeHost(ctx, "Springfield");
	expect(result).not.toBeNull();
	expect(result!.id).toBe("relation/175905");
	expect(result!.alternatives).toHaveLength(2);
	expect(result!.alternatives![0]!.name).toBe("Springfield, MO");
	expect(result!.alternatives![0]!.id).toBe("place/2");
	expect(result!.alternatives![1]!.name).toBe("Springfield, OR");
});

// ---------------------------------------------------------------------------
// findFeaturesHost
// ---------------------------------------------------------------------------

test("findFeaturesHost — successful feature search returns FindFeaturesResult", async () => {
	const el = makeEl({
		lat: 40.7127,
		lon: -74.0059,
		tags: { amenity: "restaurant", name: "Joe's" },
	});
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.ok({ elements: [el] })),
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["restaurant"],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
	});
	expect(result.features).toHaveLength(1);
	expect(result.features[0]!.id).toBe("node/1");
	expect(result.features[0]!.name).toBe("Joe's");
	expect(result.features[0]!.lat).toBe(40.7127);
	expect(result.features[0]!.lon).toBe(-74.0059);
	expect(result.count).toBe(1);
	expect(result.truncated).toBe(false);
});

test("findFeaturesHost — truncated result when source has more than limit", async () => {
	// Overpass respects `out N`; we request `limit + 1` so a source with more
	// than the display limit returns the extra element and `formatFeatures`
	// detects overflow. Simulate exactly that: limit 3 ⇒ query asks for 4 ⇒
	// Overpass returns 4 (one over) ⇒ truncated fires, count == len(features).
	const els = Array.from({ length: 4 }, (_, i) =>
		makeEl({ id: i + 1, lat: 40.7 + i * 0.001, lon: -74.0 }),
	);
	let capturedQuery: string | null = null;
	const ctx = mockCtx({
		overpass: {
			query: async (query: string) => {
				capturedQuery = query;
				return Result.ok({ elements: els });
			},
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["restaurant"],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
		limit: 3,
	});
	// mechanism: the generated query asks Overpass for one more than the limit
	expect(capturedQuery).not.toBeNull();
	expect(capturedQuery!).toContain("out center 4");
	// result: sliced to the limit, count == len(features), truncated fires
	expect(result.features).toHaveLength(3);
	expect(result.count).toBe(3);
	expect(result.truncated).toBe(true);
});

test("findFeaturesHost — non-truncated when source fits within limit", async () => {
	// limit 3 ⇒ query asks for 4 ⇒ Overpass returns 2 (under) ⇒ not truncated.
	const els = Array.from({ length: 2 }, (_, i) =>
		makeEl({ id: i + 1, lat: 40.7 + i * 0.001, lon: -74.0 }),
	);
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.ok({ elements: els })),
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["restaurant"],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
		limit: 3,
	});
	expect(result.features).toHaveLength(2);
	expect(result.count).toBe(2);
	expect(result.truncated).toBe(false);
});

test("findFeaturesHost — no types or tags throws Provide at least one", async () => {
	const ctx = mockCtx({});
	await expect(
		findFeaturesHost(ctx, { area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } } }),
	).rejects.toThrow("Provide at least one of 'types' or 'tags'.");
});

test("findFeaturesHost — unknown area throws area must specify one of", async () => {
	const ctx = mockCtx({});
	await expect(findFeaturesHost(ctx, { types: ["restaurant"], area: {} })).rejects.toThrow(
		"area must specify one of: place, bounds, around, features.",
	);
});

test("findFeaturesHost — 0 results with known type + around area has no diagnosis", async () => {
	// Known types resolve to `kind:"type"` (not unknown), and `around` supplies
	// no place metadata — so there is nothing to diagnose. Honest empty, no
	// suggestion (better than a misleading one).
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.ok({ elements: [] })),
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["restaurant", "cafe"],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
	});
	expect(result.features).toEqual([]);
	expect(result.count).toBe(0);
	expect(result.diagnosis).toBeUndefined();
});

test("findFeaturesHost — 0 results with misspelled type suggests closest (Level 0)", async () => {
	// "cofee" is unknown to the dictionary (kind:"name"); Levenshtein ≤2 against
	// the type dictionary yields "cafe". The diagnosis carries the match + hint.
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.ok({ elements: [] })),
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["cofee"],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
	});
	expect(result.count).toBe(0);
	expect(result.diagnosis).toBeDefined();
	expect(result.diagnosis!.typeMatch).toContain("cafe");
	expect(result.diagnosis!.hint).toContain('types=["cafe"]');
});

test("findFeaturesHost — 0 results with place surfaces resolved name + alternatives (Level 1)", async () => {
	// A `place` geocodes to up to 5 hits; the diagnosis reports which one was
	// picked (name + size) and the alternatives, so the model can disambiguate.
	const ctx = mockCtx({
		nominatim: {
			search: () =>
				Promise.resolve(
					Result.ok([
						makeHit({
							place_id: 1,
							name: "Athens",
							lat: "34.0",
							lon: "-83.3",
							display_name: "Athens, Georgia, United States",
							boundingbox: ["34.0", "34.1", "-83.4", "-83.2"],
						}),
						makeHit({
							place_id: 2,
							name: "Athens",
							lat: "38.0",
							lon: "23.7",
							display_name: "Athens, Greece",
							boundingbox: undefined,
						}),
					]),
				),
		},
		overpass: {
			query: () => Promise.resolve(Result.ok({ elements: [] })),
		},
	});
	const result = await findFeaturesHost(ctx, {
		types: ["restaurant"],
		area: { place: "Athens" },
	});
	expect(result.count).toBe(0);
	expect(result.diagnosis).toBeDefined();
	expect(result.diagnosis!.areaResolved).toBeDefined();
	expect(result.diagnosis!.areaResolved!.name).toBe("Athens, Georgia, United States");
	expect(result.diagnosis!.areaResolved!.sizeKm2).toBeGreaterThan(0);
	expect(result.diagnosis!.areaResolved!.alternatives).toContain("Athens, Greece");
	expect(result.diagnosis!.hint).toContain('area={"place": "Athens, Greece"');
});

// ---------------------------------------------------------------------------
// resolveGroups (exercised through findFeaturesHost)
// ---------------------------------------------------------------------------

test("findFeaturesHost — resolveGroups: type + tags produce correct groups", async () => {
	const el = makeEl({ lat: 40.7127, lon: -74.0059 });
	let capturedQuery: string | null = null;
	const ctx = mockCtx({
		overpass: {
			query: async (query: string) => {
				capturedQuery = query;
				return Result.ok({ elements: [el] });
			},
		},
	});
	await findFeaturesHost(ctx, {
		types: ["restaurant"],
		tags: [{ key: "cuisine", value: "italian", op: "eq" }],
		area: { around: { lat: 40.71, lon: -74.0, radius: 1000 } },
	});
	expect(capturedQuery).not.toBeNull();
	expect(capturedQuery!).toContain('["amenity"="restaurant"]');
	expect(capturedQuery!).toContain('["cuisine"="italian"]');
});

// ---------------------------------------------------------------------------
// searchHost
// ---------------------------------------------------------------------------

test("searchHost — maps Nominatim hits to Features (id/type from class, coords parsed)", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () =>
				Promise.resolve(
					Result.ok([
						makeHit({
							place_id: 10,
							name: "IKEA Athens",
							lat: "37.98",
							lon: "23.72",
							display_name: "IKEA Athens, Greece",
							type: "furniture",
							osm_type: "node",
							osm_id: 99,
							class: "shop",
							boundingbox: undefined,
						}),
					]),
				),
		},
	});
	const result = await searchHost(ctx, "ikea greece");
	expect(result.count).toBe(1);
	expect(result.features[0]!.id).toBe("node/99");
	expect(result.features[0]!.name).toBe("IKEA Athens");
	expect(result.features[0]!.lat).toBe(37.98);
	expect(result.features[0]!.lon).toBe(23.72);
	expect(result.features[0]!.type).toBe("shop/furniture");
	expect(result.features[0]!.tags).toBeUndefined(); // Nominatim returns no arbitrary tags
	expect(result.truncated).toBe(false);
});

test("searchHost — falls back to place/<place_id> id when osm_type/id absent", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () =>
				Promise.resolve(
					Result.ok([
						{
							place_id: 4242,
							lat: "40.0",
							lon: "20.0",
							display_name: "Somewhere",
							name: "Somewhere",
						},
					]),
				),
		},
	});
	const result = await searchHost(ctx, "somewhere");
	expect(result.features[0]!.id).toBe("place/4242");
});

test("searchHost — truncated heuristic fires at the requested limit", async () => {
	// count == requested limit ⇒ the public Nominatim cap likely bit ⇒ partial.
	const hits = Array.from({ length: 5 }, (_, i) => ({
		place_id: i + 1,
		lat: `${40 + i}`,
		lon: `${20 + i}`,
		display_name: `Hit ${i}`,
		name: `Hit ${i}`,
	}));
	const ctx = mockCtx({
		nominatim: { search: () => Promise.resolve(Result.ok(hits)) },
	});
	const result = await searchHost(ctx, "x", 5);
	expect(result.count).toBe(5);
	expect(result.truncated).toBe(true);
});

test("searchHost — NominatimBusy error throws with busy message", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.err(new NominatimBusyError({ status: 429 }))),
		},
	});
	await expect(searchHost(ctx, "x")).rejects.toThrow(NOMINATIM_BUSY_MESSAGE);
});

test("overpassQueryHost — OverpassBusy error throws with busy message", async () => {
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.err(new OverpassBusyError({ status: 503 }))),
		},
	});
	await expect(overpassQueryHost(ctx, "node")).rejects.toThrow(OVERPASS_BUSY_MESSAGE);
});

test("overpassQueryHost — non-busy errors throw the original TaggedError (preserve _tag)", async () => {
	const ctx = mockCtx({
		overpass: {
			query: () => Promise.resolve(Result.err(new OverpassHttpError({ message: "Bad gateway" }))),
		},
	});
	await expect(overpassQueryHost(ctx, "node")).rejects.toThrow("Bad gateway");
	await expect(overpassQueryHost(ctx, "node")).rejects.toBeInstanceOf(OverpassHttpError);
	await expect(overpassQueryHost(ctx, "node")).rejects.toMatchObject({ _tag: "OverpassHttp" });
});
