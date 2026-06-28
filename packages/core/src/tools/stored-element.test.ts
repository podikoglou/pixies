/// <reference types="bun" />
import { test, expect } from "bun:test";
import {
	overpassEntryToStored,
	geocodeEntryToStored,
	computeBounds,
	boundsAreaKm2,
	expandBounds,
	type StoredElement,
} from "./stored-element.ts";

test("overpassEntryToStored — re-injects name into tags so filter predicates resolve", () => {
	const stored = overpassEntryToStored({
		type: "node",
		id: 123,
		lat: 59.3,
		lon: 18.1,
		name: "Cafe",
		tags: { amenity: "cafe" },
	});
	expect(stored.id).toBe("node/123");
	expect(stored.type).toBe("node");
	expect(stored.lat).toBe(59.3);
	expect(stored.tags?.name).toBe("Cafe");
	expect(stored.tags?.amenity).toBe("cafe");
});

test("overpassEntryToStored — preserves tags even when name is absent", () => {
	const stored = overpassEntryToStored({
		type: "way",
		id: 7,
		tags: { shop: "supermarket" },
	});
	expect(stored.id).toBe("way/7");
	expect(stored.lat).toBeUndefined();
	expect(stored.tags?.shop).toBe("supermarket");
	expect(stored.tags?.name).toBeUndefined();
});

test("geocodeEntryToStored — falls back to place/<placeId> when osmType/osmId absent", () => {
	const stored = geocodeEntryToStored({
		placeId: 99,
		lat: 1,
		lon: 2,
		name: "Somewhere",
		class: "place",
		type: "village",
	});
	expect(stored.id).toBe("place/99");
	expect(stored.type).toBeUndefined();
	expect(stored.tags?.class).toBe("place");
	expect(stored.tags?.type).toBe("village");
});

test("geocodeEntryToStored — uses osm_type/osm_id for the identity when present", () => {
	const stored = geocodeEntryToStored({
		placeId: 99,
		lat: 1,
		lon: 2,
		name: "Somewhere",
		osmType: "relation",
		osmId: 12345,
	});
	expect(stored.id).toBe("relation/12345");
	expect(stored.type).toBe("relation");
});

test("computeBounds — null when no element has coordinates", () => {
	expect(computeBounds([{ id: "node/1" }, { id: "node/2" }])).toBeNull();
});

test("computeBounds — covers all elements with coordinates", () => {
	const els: StoredElement[] = [
		{ id: "a", lat: 0, lon: 0 },
		{ id: "b", lat: 10, lon: 5 },
		{ id: "c" },
	];
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
