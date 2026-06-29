/// <reference types="bun" />
import { test, expect } from "bun:test";
import {
	levenshtein,
	computeTypeMatches,
	computeDiagnosis,
	renderDiagnosisLines,
	type ResolvedKind,
} from "./diagnosis.ts";

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

test("levenshtein — identical strings are distance 0", () => {
	expect(levenshtein("cafe", "cafe")).toBe(0);
});

test("levenshtein — empty vs non-empty is the length", () => {
	expect(levenshtein("", "cafe")).toBe(4);
	expect(levenshtein("cafe", "")).toBe(4);
});

test("levenshtein — cofee → cafe is 2 (the motivating misspelling)", () => {
	expect(levenshtein("cofee", "cafe")).toBe(2);
});

test("levenshtein — single substitution is 1", () => {
	expect(levenshtein("cat", "bat")).toBe(1);
});

test("levenshtein — insertion and deletion counted", () => {
	expect(levenshtein("starbucs", "starbucks")).toBe(1); // missing 'k'
});

// ---------------------------------------------------------------------------
// computeTypeMatches
// ---------------------------------------------------------------------------

test("computeTypeMatches — misspelled type resolves to nearest dictionary key", () => {
	expect(computeTypeMatches("cofee")).toContain("cafe");
});

test("computeTypeMatches — misspelled brand resolves across brand dictionary", () => {
	expect(computeTypeMatches("starbucs")).toContain("starbucks");
});

test("computeTypeMatches — returns empty for input far from any key", () => {
	expect(computeTypeMatches("zzzzzzzzzz")).toEqual([]);
});

test("computeTypeMatches — empty input returns empty", () => {
	expect(computeTypeMatches("")).toEqual([]);
});

test("computeTypeMatches — is case-insensitive and trims", () => {
	expect(computeTypeMatches("  CoFeE  ")).toContain("cafe");
});

// ---------------------------------------------------------------------------
// computeDiagnosis
// ---------------------------------------------------------------------------

test("computeDiagnosis — unknown type yields a typeMatch + hint", () => {
	const resolvedKinds: ResolvedKind[] = [{ input: "cofee", kind: "name" }];
	const d = computeDiagnosis({ resolvedKinds });
	expect(d).toBeDefined();
	expect(d!.typeMatch).toContain("cafe");
	expect(d!.hint).toContain('types=["cafe"]');
});

test("computeDiagnosis — known type with no place returns undefined", () => {
	// Nothing to diagnose: a well-formed query over a known type found nothing.
	const resolvedKinds: ResolvedKind[] = [{ input: "restaurant", kind: "type" }];
	expect(computeDiagnosis({ resolvedKinds })).toBeUndefined();
});

test("computeDiagnosis — place surfaces alternatives in the hint", () => {
	const resolvedKinds: ResolvedKind[] = [{ input: "restaurant", kind: "type" }];
	const d = computeDiagnosis({
		resolvedKinds,
		place: { name: "Athens, GA", sizeKm2: 0.8, alternatives: ["Athens, Greece"] },
	});
	expect(d).toBeDefined();
	expect(d!.areaResolved!.name).toBe("Athens, GA");
	expect(d!.areaResolved!.sizeKm2).toBe(0.8);
	expect(d!.areaResolved!.alternatives).toEqual(["Athens, Greece"]);
	expect(d!.hint).toContain('area={"place": "Athens, Greece"');
});

test("computeDiagnosis — both type + place compose in the hint", () => {
	const resolvedKinds: ResolvedKind[] = [{ input: "cofee", kind: "name" }];
	const d = computeDiagnosis({
		resolvedKinds,
		place: { name: "Athens, GA", alternatives: ["Athens, Greece"] },
	});
	expect(d!.hint).toContain('types=["cafe"]');
	expect(d!.hint).toContain('area={"place": "Athens, Greece"');
});

// ---------------------------------------------------------------------------
// renderDiagnosisLines
// ---------------------------------------------------------------------------

test("renderDiagnosisLines — emits a ⚠ line per dimension plus the hint", () => {
	const lines = renderDiagnosisLines({
		hint: 'retry with types=["cafe"]',
		typeMatch: ["cafe"],
		areaResolved: { name: "Athens, GA", sizeKm2: 0.8, alternatives: ["Athens, Greece"] },
	});
	expect(lines.some((l) => l.startsWith("⚠ type not in dictionary") && l.includes("cafe"))).toBe(
		true,
	);
	expect(lines.some((l) => l.startsWith("⚠ place resolved to Athens, GA"))).toBe(true);
	expect(lines.some((l) => l.startsWith("hint:"))).toBe(true);
});

test("renderDiagnosisLines — omits size when absent", () => {
	const lines = renderDiagnosisLines({
		hint: "retry",
		areaResolved: { name: "Somewhere" },
	});
	const placeLine = lines.find((l) => l.startsWith("⚠ place"));
	expect(placeLine).toBeDefined();
	expect(placeLine!).not.toContain("km²");
});
