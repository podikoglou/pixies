/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Result } from "better-result";
import type { NominatimClient } from "../clients/nominatim.ts";
import {
	NOMINATIM_BUSY_MESSAGE,
	NominatimBusyError,
	NominatimHttpError,
} from "../clients/nominatim.ts";
import type { OverpassClient } from "../clients/overpass.ts";

import {
	filterHost,
	spatialJoinHost,
	geocodeHost,
	findFeaturesHost,
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

test("filterHost — empty features returns empty result", () => {
	expect(filterHost([], {})).toEqual([]);
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

test("filterHost — limit 0 returns empty", () => {
	const features: Feature[] = [{ id: "a" }, { id: "b" }];
	expect(filterHost(features, { limit: 0 })).toEqual([]);
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
// spatialJoinHost
// ---------------------------------------------------------------------------

test("spatialJoinHost — empty points returns empty result", () => {
	const targets: Feature[] = [{ id: "t1", lat: 50, lon: 10 }];
	expect(spatialJoinHost({ points: [], targets, operation: "near", radius: 1000 })).toEqual([]);
});

test("spatialJoinHost — empty targets returns empty result", () => {
	const points: Feature[] = [{ id: "p1", lat: 50, lon: 10 }];
	expect(spatialJoinHost({ points, targets: [], operation: "near", radius: 1000 })).toEqual([]);
});

test("spatialJoinHost — features without lat/lon are skipped", () => {
	const points: Feature[] = [
		{ id: "p1", lat: 50, lon: 10 },
		{ id: "p2" }, // no coords — skipped
	];
	const targets: Feature[] = [
		{ id: "t1", lat: 50, lon: 10 }, // 0 m from p1
		{ id: "t2" }, // no coords — skipped
	];
	const result = spatialJoinHost({ points, targets, operation: "near", radius: 100 });
	expect(result).toHaveLength(1);
	expect(result[0]!.point.id).toBe("p1");
	expect(result[0]!.target.id).toBe("t1");
	expect(result[0]!.distance).toBe(0);
});

test("spatialJoinHost — near: all pairs within radius", () => {
	const points: Feature[] = [
		{ id: "p1", lat: 50, lon: 10 },
		{ id: "p2", lat: 50.001, lon: 10 },
	];
	const targets: Feature[] = [
		{ id: "t1", lat: 50.0005, lon: 10 },
		{ id: "t2", lat: 49.9995, lon: 10.0008 },
	];
	// p1→t1 ~55 m, p1→t2 ~79 m, p2→t1 ~75 m, p2→t2 ~62 m — all within 200 m
	const result = spatialJoinHost({ points, targets, operation: "near", radius: 200 });
	expect(result).toHaveLength(4);
	// pairs are in nested-loop order: point-major, target-minor
	expect(result[0]!.point.id).toBe("p1");
	expect(result[0]!.target.id).toBe("t1");
	expect(result[1]!.point.id).toBe("p1");
	expect(result[1]!.target.id).toBe("t2");
	expect(result[2]!.point.id).toBe("p2");
	expect(result[2]!.target.id).toBe("t1");
	expect(result[3]!.point.id).toBe("p2");
	expect(result[3]!.target.id).toBe("t2");
	// all distances ≤ radius
	for (const p of result) expect(p.distance).toBeLessThanOrEqual(200);
});

test("spatialJoinHost — nearest: only closest target per point", () => {
	const points: Feature[] = [
		{ id: "p1", lat: 50, lon: 10 },
		{ id: "p2", lat: 50, lon: 10.001 },
	];
	const targets: Feature[] = [
		{ id: "t1", lat: 50.0005, lon: 10 },
		{ id: "t2", lat: 49.9995, lon: 10.0008 },
	];
	// p1 closer to t1 (~55 m) than t2 (~79 m) — picks t1
	// p2 closer to t2 (~62 m) than t1 (~75 m) — picks t2
	const result = spatialJoinHost({ points, targets, operation: "nearest", radius: 200 });
	expect(result).toHaveLength(2);
	expect(result[0]!.point.id).toBe("p1");
	expect(result[0]!.target.id).toBe("t1");
	expect(result[1]!.point.id).toBe("p2");
	expect(result[1]!.target.id).toBe("t2");
});

test("spatialJoinHost — nearest ignores targets outside radius", () => {
	const points: Feature[] = [{ id: "p1", lat: 50, lon: 10 }];
	const targets: Feature[] = [
		{ id: "t1", lat: 50.1, lon: 10.1 }, // ~15 km away
	];
	const result = spatialJoinHost({ points, targets, operation: "nearest", radius: 100 });
	expect(result).toEqual([]);
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

test("geocodeHost — other errors throw with error message", async () => {
	const ctx = mockCtx({
		nominatim: {
			search: () => Promise.resolve(Result.err(new NominatimHttpError({ message: "Bad request" }))),
		},
	});
	await expect(geocodeHost(ctx, "anywhere")).rejects.toThrow("Bad request");
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
	expect(result.relaxed).toBe(false);
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

test("findFeaturesHost — returns empty when relaxation exhausts", async () => {
	// Overpass always returns 0 elements; relaxation tries radius×1.5/×2/×3,
	// then broadens tags, then drops the most restrictive group — all return 0.
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
	expect(result.relaxed).toBe(true);
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
