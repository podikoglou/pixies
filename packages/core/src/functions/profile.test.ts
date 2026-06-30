/// <reference types="bun" />
import { test, expect } from "bun:test";
import fc from "fast-check";
import { profileHost, formatProfileSummary } from "./profile.ts";
import type { Feature } from "./host-functions.ts";

function feat(overrides: Partial<Feature> = {}): Feature {
	return { id: "node/1", ...overrides };
}

// ---------------------------------------------------------------------------
// profileHost (property-based)
// ---------------------------------------------------------------------------
// The fingerprint's universal invariants, asserted for ANY feature set: count
// is preserved; every coverage is in (0, 1] (the documented "0..1" range — a
// feature must not be double-counted); tag/numeric lists respect maxTags;
// tags are sorted by coverage descending; cardinality/values-length agree; and
// every numeric entry satisfies min ≤ median ≤ max.

/** Identifier-shaped tag keys (no `__proto__`/constructor). `"name"` is mixed
 *  in often so it collides with the hoisted `.name` field — a realistic OSM key. */
const profKeyArb = fc.oneof(
	fc.constant("name"),
	fc.string({ minLength: 1, maxLength: 8 }).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)),
);

const tagsArb = fc
	.uniqueArray(fc.tuple(profKeyArb, fc.string({ maxLength: 8 })), {
		selector: ([k]) => k,
		minLength: 0,
		maxLength: 5,
	})
	.map((entries) => Object.fromEntries(entries) as Record<string, string>);

const profFeatureArb = fc
	.record({
		id: fc.string({ minLength: 1, maxLength: 6 }),
		name: fc.option(fc.string({ maxLength: 8 })),
		tags: fc.option(tagsArb),
	})
	.map((f) => ({
		id: f.id,
		...(f.name !== null ? { name: f.name } : {}),
		...(f.tags !== null ? { tags: f.tags } : {}),
	}));

test("profileHost: count preserved, coverage in (0,1], lists bounded by maxTags, tags coverage-sorted, numeric min<=median<=max, for any feature set", () => {
	fc.assert(
		fc.property(
			fc.array(profFeatureArb, { maxLength: 20 }),
			fc.integer({ min: 0, max: 20 }),
			(features, maxTags) => {
				const r = profileHost(features, maxTags);
				if (r.count !== features.length) return false;
				if (r.tags.length > maxTags || r.numeric.length > maxTags) return false;
				let prevCov = 2;
				for (const t of r.tags) {
					if (!(t.coverage > 0 && t.coverage <= 1)) return false;
					if (t.coverage > prevCov) return false; // non-increasing coverage
					prevCov = t.coverage;
					if (t.cardinality < 1) return false;
					const expectedLen = t.cardinality > 8 ? 3 : t.cardinality;
					if (t.values.length !== expectedLen) return false;
				}
				for (const nm of r.numeric) {
					if (!(nm.coverage > 0 && nm.coverage <= 1)) return false;
					if (!(nm.min <= nm.median && nm.median <= nm.max)) return false;
				}
				return true;
			},
		),
	);
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
