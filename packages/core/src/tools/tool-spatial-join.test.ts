/// <reference types="bun" />
import { test, expect } from "bun:test";
import { haversineMeters } from "./tool-spatial-join.ts";

test("haversineMeters — zero distance for identical points", () => {
	expect(haversineMeters(59.3, 18.1, 59.3, 18.1)).toBe(0);
});

test("haversineMeters — symmetric in argument order", () => {
	const a = haversineMeters(59.3, 18.1, 60.0, 19.0);
	const b = haversineMeters(60.0, 19.0, 59.3, 18.1);
	expect(a).toBeCloseTo(b, 5);
});

test("haversineMeters — Stockholm → Uppsala is ~60 km (known geographic anchor)", () => {
	// Stockholm 59.329, 18.069; Uppsala 59.858, 17.638.
	const d = haversineMeters(59.329, 18.069, 59.858, 17.638);
	expect(d).toBeGreaterThan(60_000);
	expect(d).toBeLessThan(70_000);
});

test("haversineMeters — 1 degree of latitude ≈ 111 km", () => {
	const d = haversineMeters(0, 0, 1, 0);
	expect(d).toBeGreaterThan(110_000);
	expect(d).toBeLessThan(112_000);
});

test("haversineMeters — east-west distance contracts with cos(latitude)", () => {
	const equator = haversineMeters(0, 0, 0, 1);
	const polar = haversineMeters(60, 0, 60, 1);
	expect(polar).toBeLessThan(equator);
	// ~55 km at 60°N (111 * cos(60°) ≈ 55.5).
	expect(polar).toBeGreaterThan(50_000);
	expect(polar).toBeLessThan(60_000);
});
