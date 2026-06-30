/// <reference types="bun" />
import { test, expect } from "bun:test";
import fc from "fast-check";
import { computeBounds, boundsAreaKm2, expandBounds } from "./geometry.ts";
import type { Bounds } from "./geometry.ts";

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

// ---------------------------------------------------------------------------
// computeBounds — property-based
// ---------------------------------------------------------------------------
// A bounding box MUST bound: the result is null iff no element carries BOTH
// lat and lon; otherwise it equals the min/max of the coordinate extremes
// (tight) and every input point lies inside it (containment). Holds for any
// point cloud, including elements missing one axis (which must be skipped).

/** Element with independently-optional lat/lon (some carry only one axis). */
const coordElementArb = fc
	.record({
		lat: fc.option(fc.float({ min: -90, max: 90, noNaN: true })),
		lon: fc.option(fc.float({ min: -180, max: 180, noNaN: true })),
	})
	.map((e) => ({ lat: e.lat ?? undefined, lon: e.lon ?? undefined }));

test("computeBounds — null iff no element has both coords; else tight bounds containing every point", () => {
	fc.assert(
		fc.property(fc.array(coordElementArb), (els) => {
			const withCoords = els.filter(
				(e): e is { lat: number; lon: number } => e.lat !== undefined && e.lon !== undefined,
			);
			const bounds = computeBounds(els);
			if (withCoords.length === 0) return bounds === null;
			if (bounds === null) return false;
			const lats = withCoords.map((e) => e.lat);
			const lons = withCoords.map((e) => e.lon);
			// tightness: bounds equal the coordinate extremes
			if (bounds.minlat !== Math.min(...lats) || bounds.maxlat !== Math.max(...lats)) return false;
			if (bounds.minlon !== Math.min(...lons) || bounds.maxlon !== Math.max(...lons)) return false;
			// well-formed ordering
			if (bounds.minlat > bounds.maxlat || bounds.minlon > bounds.maxlon) return false;
			// containment: every input point lies inside the box
			return withCoords.every(
				(e) =>
					e.lat >= bounds.minlat &&
					e.lat <= bounds.maxlat &&
					e.lon >= bounds.minlon &&
					e.lon <= bounds.maxlon,
			);
		}),
	);
});

// ---------------------------------------------------------------------------
// expandBounds — property-based
// ---------------------------------------------------------------------------
// Expanding outward by a positive padding must STRICTLY contain the input on
// all four sides (the contract that keeps edge-of-area features from being
// clipped). Zero padding is the identity. Latitudes stay clear of the poles so
// the cos(midLat) longitude scaling stays finite and positive.

const loArb = fc.float({ min: -80, max: 80, noNaN: true });
const spanArb = fc.float({ min: 0, max: 8, noNaN: true });

const boundsArb: fc.Arbitrary<Bounds> = fc
	.record({ minlat: loArb, minlon: fc.float({ min: -170, max: 170, noNaN: true }) })
	.chain(({ minlat, minlon }) =>
		fc.record({ latSpan: spanArb, lonSpan: spanArb }).map(({ latSpan, lonSpan }) => ({
			minlat,
			minlon,
			maxlat: minlat + latSpan,
			maxlon: minlon + lonSpan,
		})),
	);

test("expandBounds — strictly contains the input on all four sides for any positive padding", () => {
	fc.assert(
		fc.property(boundsArb, fc.float({ min: 1, max: 100_000, noNaN: true }), (b, meters) => {
			const out = expandBounds(b, meters);
			return (
				out.minlat < b.minlat &&
				out.maxlat > b.maxlat &&
				out.minlon < b.minlon &&
				out.maxlon > b.maxlon
			);
		}),
	);
});

test("expandBounds — zero padding is the identity for any bounds", () => {
	fc.assert(
		fc.property(boundsArb, (b) => {
			const out = expandBounds(b, 0);
			return (
				out.minlat === b.minlat &&
				out.maxlat === b.maxlat &&
				out.minlon === b.minlon &&
				out.maxlon === b.maxlon
			);
		}),
	);
});
