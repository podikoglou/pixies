/// <reference types="bun" />
import { test, expect } from "bun:test";
import { computeBounds, boundsAreaKm2, expandBounds } from "./stored-element.ts";

test("computeBounds — null when no element has coordinates", () => {
	expect(computeBounds([{}, {}])).toBeNull();
});

test("computeBounds — covers all elements with coordinates", () => {
	const els = [{ id: "a", lat: 0, lon: 0 }, { id: "b", lat: 10, lon: 5 }, { id: "c" }];
	expect(computeBounds(els)).toEqual({ minlat: 0, minlon: 0, maxlat: 10, maxlon: 5 });
});

test("boundsAreaKm2 — zero for a degenerate bbox", () => {
	expect(boundsAreaKm2({ minlat: 5, minlon: 5, maxlat: 5, maxlon: 5 })).toBe(0);
});

test("boundsAreaKm2 — scales with cos(latitude) for the longitude axis", () => {
	const equator = boundsAreaKm2({ minlat: -0.5, minlon: -0.5, maxlat: 0.5, maxlon: 0.5 });
	const polar = boundsAreaKm2({ minlat: 59.5, minlon: -0.5, maxlat: 60.5, maxlon: 0.5 });
	expect(polar).toBeLessThan(equator);
	expect(polar).toBeGreaterThan(0);
});

test("expandBounds — grows outward symmetrically", () => {
	const before = { minlat: 0, minlon: 0, maxlat: 0, maxlon: 0 };
	const after = expandBounds(before, 1_000);
	expect(after.minlat).toBeLessThan(0);
	expect(after.maxlat).toBeGreaterThan(0);
	expect(after.minlon).toBeLessThan(0);
	expect(after.maxlon).toBeGreaterThan(0);
});
