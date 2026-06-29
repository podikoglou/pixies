/// <reference types="bun" />
import { test, expect } from "bun:test";
import { profileHost, formatProfileSummary } from "./profile.ts";
import type { Feature } from "./host-functions.ts";

function feat(overrides: Partial<Feature> = {}): Feature {
	return { id: "node/1", ...overrides };
}

test("profileHost — n=0 returns empty fingerprint (no division by zero)", () => {
	expect(profileHost([])).toEqual({ count: 0, tags: [], numeric: [] });
});

test("profileHost — coverage is features-having-key / count", () => {
	const features: Feature[] = [
		feat({ id: "a", tags: { amenity: "cafe", population: "10000" } }),
		feat({ id: "b", tags: { amenity: "cafe", population: "20000" } }),
		feat({ id: "c", tags: { amenity: "cafe" } }), // no population
	];
	const r = profileHost(features);
	expect(r.count).toBe(3);
	const amenity = r.tags.find((t) => t.key === "amenity");
	expect(amenity?.coverage).toBe(1);
	const population = r.tags.find((t) => t.key === "population");
	expect(population?.coverage).toBeCloseTo(2 / 3);
});

test("profileHost — values: ≤8 distinct lists all, >8 lists first 3 with cardinality", () => {
	const many = Array.from({ length: 10 }, (_, i) =>
		feat({ id: `n${i}`, tags: { ref: String(i) } }),
	);
	const r = profileHost(many);
	const ref = r.tags.find((t) => t.key === "ref")!;
	expect(ref.cardinality).toBe(10);
	expect(ref.values).toHaveLength(3); // >8 → first 3

	const few = [
		feat({ id: "a", tags: { cuisine: "italian" } }),
		feat({ id: "b", tags: { cuisine: "french" } }),
	];
	const r2 = profileHost(few);
	const cuisine = r2.tags.find((t) => t.key === "cuisine")!;
	expect(cuisine.cardinality).toBe(2);
	expect(cuisine.values).toEqual(expect.arrayContaining(["italian", "french"]));
});

test("profileHost — numeric detection: population classified numeric with min/max/median", () => {
	const features: Feature[] = [
		feat({ id: "a", tags: { population: "10000" } }),
		feat({ id: "b", tags: { population: "30000" } }),
		feat({ id: "c", tags: { population: "20000" } }),
	];
	const r = profileHost(features);
	const pop = r.numeric.find((n) => n.key === "population");
	expect(pop).toBeDefined();
	expect(pop!.min).toBe(10000);
	expect(pop!.max).toBe(30000);
	expect(pop!.median).toBe(20000);
});

test("profileHost — numeric detection requires >=50% of values to parse", () => {
	// 2 of 3 parse → 0.67 ≥ 0.5 → numeric
	const numeric = [
		feat({ id: "a", tags: { ele: "100" } }),
		feat({ id: "b", tags: { ele: "200" } }),
		feat({ id: "c", tags: { ele: "high" } }),
	];
	expect(profileHost(numeric).numeric.find((n) => n.key === "ele")).toBeDefined();
	// 1 of 3 parse → 0.33 < 0.5 → not numeric
	const notNumeric = [
		feat({ id: "a", tags: { ele: "100" } }),
		feat({ id: "b", tags: { ele: "high" } }),
		feat({ id: "c", tags: { ele: "low" } }),
	];
	expect(profileHost(notNumeric).numeric.find((n) => n.key === "ele")).toBeUndefined();
});

test("profileHost — parses OSM loose numeric formats (30 000, 30,000, ~30000)", () => {
	const features: Feature[] = [
		feat({ id: "a", tags: { population: "30 000" } }),
		feat({ id: "b", tags: { population: "30,000" } }),
		feat({ id: "c", tags: { population: "~30000" } }),
	];
	const pop = profileHost(features).numeric.find((n) => n.key === "population");
	expect(pop).toBeDefined();
	expect(pop!.min).toBe(30000);
	expect(pop!.max).toBe(30000);
});

test("profileHost — treats hoisted name as the 'name' key", () => {
	const features: Feature[] = [
		feat({ id: "a", name: "Cafe A" }),
		feat({ id: "b", name: "Cafe B" }),
	];
	const r = profileHost(features);
	const nameTag = r.tags.find((t) => t.key === "name");
	expect(nameTag?.coverage).toBe(1);
	expect(nameTag?.cardinality).toBe(2);
});

test("profileHost — respects maxTags limit, keeping highest-coverage tags", () => {
	const features: Feature[] = Array.from({ length: 5 }, (_, i) =>
		feat({ id: `n${i}`, tags: { k0: "v", k1: "v", k2: "v", k3: "v", k4: "v" } }),
	);
	const r = profileHost(features, 3);
	expect(r.tags).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// formatProfileSummary
// ---------------------------------------------------------------------------

test("formatProfileSummary — n=0 renders empty", () => {
	expect(formatProfileSummary({ count: 0, tags: [], numeric: [] })).toBe(
		"profile(0 features) → empty\n",
	);
});

test("formatProfileSummary — n=1 appends the not-a-distribution warning", () => {
	const r = profileHost([feat({ id: "a", tags: { amenity: "cafe" } })]);
	const out = formatProfileSummary(r);
	expect(out).toContain("profile(1 feature)");
	expect(out).toContain("⚠ profile of 1 feature — not a distribution");
});

test("formatProfileSummary — renders coverage, values, and numeric range", () => {
	const r = profileHost([
		feat({ id: "a", tags: { amenity: "cafe", population: "10000" } }),
		feat({ id: "b", tags: { amenity: "cafe", population: "40000" } }),
	]);
	const out = formatProfileSummary(r);
	expect(out).toContain("amenity  100%");
	expect(out).toContain("numeric 10000–40000");
});
