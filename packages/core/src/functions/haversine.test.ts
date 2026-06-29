/// <reference types="bun" />
import { test, expect } from "bun:test";
import fc from "fast-check";
import { haversineMeters } from "./haversine.ts";

/** Any valid WGS-84 latitude/longitude pair. */
const latLonPair = fc.tuple(
	fc.float({ min: -90, max: 90, noNaN: true }),
	fc.float({ min: -180, max: 180, noNaN: true }),
);

test("haversineMeters — zero distance for any identical point", () => {
	fc.assert(fc.property(latLonPair, ([lat, lon]) => haversineMeters(lat, lon, lat, lon) === 0));
});

test("haversineMeters — symmetric in argument order for any two points", () => {
	fc.assert(
		fc.property(latLonPair, latLonPair, ([lat1, lon1], [lat2, lon2]) => {
			const a = haversineMeters(lat1, lon1, lat2, lon2);
			const b = haversineMeters(lat2, lon2, lat1, lon1);
			return Math.abs(a - b) < 1e-6;
		}),
	);
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
