/// <reference types="bun" />
import { test, expect } from "bun:test";
import { resolveType } from "./find-features-types.ts";
import { resolveBrand, isBrand } from "./find-features-brands.ts";

test("resolveType — known type returns its tag groups", () => {
	expect(resolveType("restaurant")).toEqual([[{ key: "amenity", value: "restaurant" }]]);
	expect(resolveType("RESTAURANT")).toEqual([[{ key: "amenity", value: "restaurant" }]]);
	expect(resolveType(" restaurant ")).toEqual([[{ key: "amenity", value: "restaurant" }]]);
});

test("resolveType — alias entries collapse to the canonical type", () => {
	expect(resolveType("fastfood")).toEqual([[{ key: "amenity", value: "fast_food" }]]);
	expect(resolveType("convenience")).toEqual([[{ key: "shop", value: "convenience" }]]);
});

test("resolveType — unknown type returns null (caller falls back to name regex)", () => {
	expect(resolveType("floompy")).toBeNull();
});

test("resolveBrand — known brand returns one OR-group per optional + a name fallback", () => {
	const groups = resolveBrand("LIDL");
	// LIDL has 2 optional shop-value variants + 1 name fallback = 3 groups.
	expect(groups).toHaveLength(3);
	// Every non-fallback group includes the brand clause AND-ed in.
	expect(groups[0]).toContainEqual({ key: "brand", value: "lidl", op: "iregex" });
	// Last group is the name-only fallback.
	expect(groups[groups.length - 1]).toEqual([{ key: "name", value: "LIDL", op: "iregex" }]);
});

test("resolveBrand — unknown brand returns brand-regex + name-regex fallback", () => {
	const groups = resolveBrand("FloompyCorp");
	expect(groups).toHaveLength(2);
	expect(groups[0]).toEqual([{ key: "brand", value: "FloompyCorp", op: "iregex" }]);
	expect(groups[1]).toEqual([{ key: "name", value: "FloompyCorp", op: "iregex" }]);
});

test("isBrand — true for known brands (case-insensitive), false for unknown", () => {
	expect(isBrand("LIDL")).toBe(true);
	expect(isBrand("lidl")).toBe(true);
	expect(isBrand("restaurant")).toBe(false);
	expect(isBrand("floompy")).toBe(false);
});
