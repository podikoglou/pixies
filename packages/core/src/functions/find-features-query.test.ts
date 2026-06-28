/// <reference types="bun" />
import { test, expect } from "bun:test";
import {
	generateOverpassQuery,
	validateOverpassQL,
	buildTagClause,
	buildAreaClause,
	MAX_BBOX_AREA_KM2,
	type ResolvedArea,
} from "./find-features-query.ts";

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

test("validateOverpassQL — clean query passes", () => {
	const q = generateOverpassQuery({
		groups: [[{ key: "amenity", value: "restaurant" }]],
		area: bbox,
	});
	expect(validateOverpassQL(q, bbox).valid).toBe(true);
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
