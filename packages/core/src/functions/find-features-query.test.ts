/// <reference types="bun" />
import { test, expect } from "bun:test";
import fc from "fast-check";
import {
	generateOverpassQuery,
	validateOverpassQL,
	buildTagClause,
	buildAreaClause,
	MAX_BBOX_AREA_KM2,
	type ResolvedArea,
} from "./find-features-query.ts";
import type { TagClause } from "./find-features-types.ts";

const bbox: ResolvedArea = {
	kind: "bbox",
	bounds: { minlat: 59, minlon: 17, maxlat: 60, maxlon: 19 },
};

test("buildTagClause — eq, iregex, exists, neq, notexists, regex", () => {
	expect(buildTagClause({ key: "amenity", value: "restaurant" })).toBe('["amenity"="restaurant"]');
	expect(buildTagClause({ key: "name", value: "lidl", op: "iregex" })).toBe('["name"~"lidl",i]');
	expect(buildTagClause({ key: "population", op: "exists" })).toBe('["population"]');
	expect(buildTagClause({ key: "x", op: "notexists" })).toBe('[!"x"]');
	expect(buildTagClause({ key: "x", value: "y", op: "neq" })).toBe('["x"!="y"]');
	expect(buildTagClause({ key: "x", value: "^foo", op: "regex" })).toBe('["x"~"^foo"]');
});

test("buildTagClause — escapes embedded quotes and backslashes", () => {
	expect(buildTagClause({ key: "name", value: 'a"b\\c' })).toBe('["name"="a\\"b\\\\c"]');
});

test("buildAreaClause — bbox is (south,west,north,east) order", () => {
	expect(buildAreaClause(bbox)).toBe("(59,17,60,19)");
});

test("buildAreaClause — around uses radius,lat,lon", () => {
	expect(buildAreaClause({ kind: "around", lat: 59.3, lon: 18.1, radius: 1500 })).toBe(
		"(around:1500,59.3,18.1)",
	);
});

test("generateOverpassQuery — emits node+way per OR-group, wrapped in a union", () => {
	const q = generateOverpassQuery({
		groups: [[{ key: "amenity", value: "restaurant" }]],
		area: bbox,
		limit: 100,
	});
	expect(q).toContain("[out:json][timeout:5];");
	expect(q).toContain('node["amenity"="restaurant"](59,17,60,19);');
	expect(q).toContain('way["amenity"="restaurant"](59,17,60,19);');
	expect(q).toContain("out center 100;");
	// The statements are wrapped in a parenthesised union, on its own line
	// after the [out:json] header.
	expect(q).toMatch(/\n\(\n/);
	expect(q).toMatch(/\n\);\n/);
});

test("generateOverpassQuery — name regex is AND-ed onto every group", () => {
	const q = generateOverpassQuery({
		groups: [[{ key: "amenity", value: "restaurant" }]],
		nameRegex: "^starbucks",
		area: bbox,
	});
	expect(q).toContain('node["amenity"="restaurant"]["name"~"^starbucks",i]');
});

test("generateOverpassQuery — multiple groups each emit node+way", () => {
	const q = generateOverpassQuery({
		groups: [[{ key: "amenity", value: "cafe" }], [{ key: "amenity", value: "restaurant" }]],
		area: bbox,
	});
	expect(q.match(/node\["amenity"="cafe"/g)).toHaveLength(1);
	expect(q.match(/way\["amenity"="cafe"/g)).toHaveLength(1);
	expect(q.match(/node\["amenity"="restaurant"/g)).toHaveLength(1);
	expect(q.match(/way\["amenity"="restaurant"/g)).toHaveLength(1);
});

test("validateOverpassQL — oversized bbox is rejected", () => {
	const huge: ResolvedArea = {
		kind: "bbox",
		bounds: { minlat: -40, minlon: -40, maxlat: 40, maxlon: 40 },
	};
	const q = generateOverpassQuery({
		groups: [[{ key: "amenity", value: "restaurant" }]],
		area: huge,
	});
	const v = validateOverpassQL(q, huge);
	expect(v.valid).toBe(false);
	expect(v.errors.join(" ")).toContain("exceeds safe limit");
});

test("MAX_BBOX_AREA_KM2 — sized to admit a metro region but reject a country scan", () => {
	// ~1° square at the equator is ~12,300 km² — should pass.
	const metro = {
		kind: "bbox" as const,
		bounds: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 },
	};
	const q1 = generateOverpassQuery({
		groups: [[{ key: "x", value: "y" }]],
		area: metro,
	});
	expect(validateOverpassQL(q1, metro).valid).toBe(true);
	// 25° square is well beyond MAX — should fail.
	expect(MAX_BBOX_AREA_KM2).toBeLessThan(25 * 25 * 111 * 111);
});

// ---------------------------------------------------------------------------
// generateOverpassQuery ↔ validateOverpassQL — round-trip (property-based)
// ---------------------------------------------------------------------------
// The generator is the trusted path; the validator is its safety net. The
// contract: for ANY QueryInput whose bbox is within the area limit, the query
// the generator emits MUST pass its own validator. Values (tag keys/values,
// name regex) are model-supplied and may contain any character — including the
// bracket/paren/quote characters the validator's balance check must not
// mis-count inside quoted Overpass strings.

/** Value alphabet that includes the chars the validator must not mis-count. */
const punctStr = fc
	.array(fc.constantFrom(...'abcABC012 []()"\\,.'), { minLength: 0, maxLength: 16 })
	.map((chars) => chars.join(""));

const tagClauseArb: fc.Arbitrary<TagClause> = fc.record({
	key: punctStr,
	value: punctStr,
	op: fc.constantFrom("eq", "neq", "regex", "iregex", "exists", "notexists"),
}) as fc.Arbitrary<TagClause>;

/** In-limit bbox: ≤1° spans ⇒ ≤~12,300 km², well under MAX_BBOX_AREA_KM2. */
const bboxArb: fc.Arbitrary<ResolvedArea> = fc
	.record({
		minlat: fc.float({ min: -80, max: 80, noNaN: true }),
		minlon: fc.float({ min: -170, max: 170, noNaN: true }),
		latSpan: fc.float({ min: 0, max: 1, noNaN: true }),
		lonSpan: fc.float({ min: 0, max: 1, noNaN: true }),
	})
	.map((b) => ({
		kind: "bbox" as const,
		bounds: {
			minlat: b.minlat,
			minlon: b.minlon,
			maxlat: b.minlat + b.latSpan,
			maxlon: b.minlon + b.lonSpan,
		},
	}));

const aroundArb: fc.Arbitrary<ResolvedArea> = fc
	.record({
		lat: fc.float({ min: -90, max: 90, noNaN: true }),
		lon: fc.float({ min: -180, max: 180, noNaN: true }),
		radius: fc.float({ min: 0, max: 100_000, noNaN: true }),
	})
	.map((a) => ({ kind: "around" as const, ...a }));

const queryInputArb = fc.record({
	groups: fc.array(fc.array(tagClauseArb, { minLength: 1 }), { minLength: 1 }),
	area: fc.oneof(bboxArb, aroundArb),
	nameRegex: fc.option(punctStr).map((v) => v ?? undefined),
	limit: fc.option(fc.integer({ min: 1, max: 1000 })).map((v) => v ?? undefined),
	includeGeometry: fc.boolean(),
});

test("generateOverpassQuery: output always passes validateOverpassQL for any in-limit input", () => {
	fc.assert(
		fc.property(queryInputArb, (input) => {
			const query = generateOverpassQuery(input);
			return validateOverpassQL(query, input.area).valid;
		}),
	);
});
