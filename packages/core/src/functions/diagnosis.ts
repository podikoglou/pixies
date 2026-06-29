import { TYPE_DICTIONARY } from "./find-features-types.ts";
import { BRAND_DICTIONARY } from "./find-features-brands.ts";

/**
 * Diagnosis for a 0-result `find_features`. A zero-result is a measurement, not
 * a failure: the query probed a point in the `(area × type × tags × name)`
 * space and found it empty. The diagnosis surfaces which dimension likely
 * caused the empty result and suggests a concrete next query — the compiler /
 * search-engine "did you mean?" pattern.
 *
 * Computed from data already in hand (no extra network calls). Levels 0–1 here;
 * Level 2 (Overpass `out count;` bisection) and Level 3 (Nominatim fuzzy name)
 * remain budget-gated (#251).
 */
export interface Diagnosis {
	/** Model-readable suggested next step (e.g. `retry with types=["cafe"]`). */
	hint: string;
	/** Closest type/brand dictionary matches (Level 0), when an input type was unknown. */
	typeMatch?: string[];
	/** Resolved place metadata (Level 1), when the area was a `place`. */
	areaResolved?: {
		name: string;
		sizeKm2?: number;
		alternatives?: string[];
	};
}

/** How a `types` entry resolved — only `name`-kind inputs are "unknown to the
 *  dictionary" and thus candidates for Level 0 suggestion. */
export interface ResolvedKind {
	input: string;
	kind: "type" | "brand" | "name";
}

/** Place metadata retained by `resolveArea` for Level 1 diagnosis. */
export interface ResolvedPlace {
	name: string;
	sizeKm2?: number;
	alternatives: string[];
}

/** Max Levenshtein distance for a type/brand suggestion. */
const MAX_TYPE_DISTANCE = 2;

/**
 * Closest type/brand dictionary keys within edit distance 2 of `input`,
 * nearest first. Covers both the type dictionary (`cafe`, `restaurant`, …) and
 * the brand dictionary (`ikea`, `lidl`, …) so a misspelled brand ("starbucs")
 * or type ("cofee") both resolve.
 */
export function computeTypeMatches(input: string, max = 3): string[] {
	const needle = input.trim().toLowerCase();
	if (!needle) return [];
	const candidates = [...Object.keys(TYPE_DICTIONARY), ...Object.keys(BRAND_DICTIONARY)];
	return candidates
		.map((key) => ({ key, dist: levenshtein(needle, key) }))
		.filter((c) => c.dist <= MAX_TYPE_DISTANCE)
		.sort((a, b) => a.dist - b.dist)
		.slice(0, max)
		.map((c) => c.key);
}

/**
 * Build a diagnosis from data already in hand. `resolvedKinds` drives Level 0
 * (type/brand dictionary); `place` drives Level 1 (area validation). Returns
 * `undefined` when there is nothing useful to say (a well-formed query over a
 * known place that simply found nothing — better no suggestion than a
 * misleading one).
 */
export function computeDiagnosis(opts: {
	resolvedKinds: ResolvedKind[];
	place?: ResolvedPlace;
}): Diagnosis | undefined {
	const unknownInputs = opts.resolvedKinds.filter((k) => k.kind === "name");
	const typeMatch =
		unknownInputs.length > 0 ? computeTypeMatches(unknownInputs[0]!.input) : undefined;
	const hasTypeMatch = !!typeMatch && typeMatch.length > 0;
	const place = opts.place;

	if (!hasTypeMatch && !place) return undefined;

	const diagnosis: Diagnosis = {
		hint: buildHint(hasTypeMatch ? typeMatch : undefined, place),
	};
	if (hasTypeMatch) diagnosis.typeMatch = typeMatch;
	if (place) {
		const alternatives = place.alternatives.filter((a) => a.length > 0);
		diagnosis.areaResolved = {
			name: place.name,
			...(place.sizeKm2 !== undefined ? { sizeKm2: place.sizeKm2 } : {}),
			...(alternatives.length > 0 ? { alternatives } : {}),
		};
	}
	return diagnosis;
}

function buildHint(typeMatch: string[] | undefined, place?: ResolvedPlace): string {
	const parts: string[] = [];
	if (typeMatch && typeMatch.length > 0) parts.push(`types=["${typeMatch[0]}"]`);
	const alt = place?.alternatives.find((a) => a.length > 0);
	if (alt) parts.push(`area={"place": "${alt}"}`);
	if (parts.length === 0)
		return "no suggestion available — query was well-formed but found nothing";
	return `retry with ${parts.join(", ")}`;
}

/**
 * Render a diagnosis as model-readable "⚠" lines (no trailing newlines). Mirrors
 * the spec example:
 *
 *     ⚠ type not in dictionary. Closest: cafe.
 *     ⚠ place resolved to Athens, GA (0.8 km²). Alternatives: Athens, Greece.
 *     hint: retry with types=["cafe"], area={"place": "Athens, Greece"}
 */
export function renderDiagnosisLines(d: Diagnosis): string[] {
	const lines: string[] = [];
	if (d.typeMatch && d.typeMatch.length > 0) {
		lines.push(`⚠ type not in dictionary. Closest: ${d.typeMatch.join(", ")}.`);
	}
	if (d.areaResolved) {
		const size =
			d.areaResolved.sizeKm2 !== undefined ? ` (${formatKm2(d.areaResolved.sizeKm2)})` : "";
		const alts =
			d.areaResolved.alternatives && d.areaResolved.alternatives.length > 0
				? `. Alternatives: ${d.areaResolved.alternatives.join(", ")}`
				: "";
		lines.push(`⚠ place resolved to ${d.areaResolved.name}${size}${alts}`);
	}
	lines.push(`hint: ${d.hint}`);
	return lines;
}

function formatKm2(km2: number): string {
	return `${km2 < 10 ? km2.toFixed(1) : Math.round(km2)} km²`;
}

/**
 * Standard Levenshtein edit distance (iterative two-row DP). Used only for
 * short dictionary-key comparisons, so the O(m·n) cost is negligible.
 */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = Array.from({ length: n + 1 }, () => 0);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n]!;
}
