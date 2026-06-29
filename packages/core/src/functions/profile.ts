import { parseOsmNumber } from "./filter-logic.ts";
import type { Feature } from "./host-functions.ts";

/**
 * `profile` — the keystone primitive that makes blind filtering unblind.
 *
 * Schema-level visibility (which tags exist, coverage, cardinality, numeric
 * ranges) without row-level visibility. The model cannot write
 * `filter(where="population < 30000")` unless it knows the field and its
 * distribution; `profile` replaces the guesswork / single-row peek with one
 * bounded call. See the tool-surface spec, Principle 3 + the `profile` section.
 *
 * Pure (no I/O); operates on a feature list already fetched.
 */

/** A key is classified numeric only when this fraction of the features that
 *  carry it parse as a number — prevents stray numeric-looking categoricals. */
const NUMERIC_RATIO = 0.5;

export interface TagProfile {
	key: string;
	/** Features having the key / count (0..1). */
	coverage: number;
	/** Distinct values across features that have the key. */
	cardinality: number;
	/** ≤8 distinct → all; >8 → first 3 (insertion order). */
	values: string[];
}

export interface NumericProfile {
	key: string;
	coverage: number;
	min: number;
	max: number;
	median: number;
}

export interface ProfileResult {
	count: number;
	/** Top-N tags by coverage (default N=12). */
	tags: TagProfile[];
	/** Numeric-detected keys, top-N by coverage, with min/max/median. */
	numeric: NumericProfile[];
}

/**
 * Compute a bounded statistical fingerprint of a feature list. Treats the
 * hoisted `name` field as the tag key `"name"` (it is filterable via
 * `where="name =~ …"`). Guards:
 * - n=0 → `{count: 0, tags: [], numeric: []}` (no division by zero).
 * - numeric detection uses the ≥50% rule on features that carry the key.
 */
export function profileHost(features: Feature[], maxTags = 12): ProfileResult {
	const n = features.length;
	if (n === 0) return { count: 0, tags: [], numeric: [] };

	const keyValues = new Map<string, string[]>();
	for (const f of features) {
		const entries: Array<[string, string]> = [];
		if (f.name !== undefined) entries.push(["name", f.name]);
		if (f.tags) for (const [k, v] of Object.entries(f.tags)) entries.push([k, v]);
		for (const [k, v] of entries) {
			let list = keyValues.get(k);
			if (!list) {
				list = [];
				keyValues.set(k, list);
			}
			list.push(v);
		}
	}

	const tagProfiles: TagProfile[] = [];
	const numeric: NumericProfile[] = [];
	for (const [key, values] of keyValues) {
		const coverage = values.length / n;
		const unique = new Set(values);
		const cardinality = unique.size;
		const valueList = cardinality <= 8 ? [...unique] : [...unique].slice(0, 3);
		tagProfiles.push({ key, coverage, cardinality, values: valueList });

		const parsed = mapFilterNumbers(values);
		if (values.length > 0 && parsed.length / values.length >= NUMERIC_RATIO) {
			parsed.sort((a, b) => a - b);
			numeric.push({
				key,
				coverage,
				min: parsed[0]!,
				max: parsed[parsed.length - 1]!,
				median: medianOf(parsed),
			});
		}
	}

	const byCoverage = (a: { coverage: number; key: string }, b: { coverage: number; key: string }) =>
		b.coverage - a.coverage || a.key.localeCompare(b.key);
	tagProfiles.sort(byCoverage);
	numeric.sort(byCoverage);
	return {
		count: n,
		tags: tagProfiles.slice(0, maxTags),
		numeric: numeric.slice(0, maxTags),
	};
}

function mapFilterNumbers(values: string[]): number[] {
	const out: number[] = [];
	for (const v of values) {
		const n = parseOsmNumber(v);
		if (n !== null) out.push(n);
	}
	return out;
}

function medianOf(sortedAsc: number[]): number {
	const mid = Math.floor(sortedAsc.length / 2);
	return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2 : sortedAsc[mid]!;
}

/**
 * Render a profile as the model-visible fingerprint block. n=1 appends a
 * warning: every tag shows 100% coverage, which is a fingerprint of one row,
 * not a distribution.
 */
export function formatProfileSummary(result: ProfileResult): string {
	if (result.count === 0) return "profile(0 features) → empty\n";
	const lines = [`profile(${result.count} feature${result.count === 1 ? "" : "s"})`];
	const numericByKey = new Map(result.numeric.map((n) => [n.key, n]));
	const tagged = new Set(result.tags.map((t) => t.key));
	for (const t of result.tags) {
		lines.push(
			`  ${t.key}  ${pct(t.coverage)}  ${valueDesc(t)}${numericLine(numericByKey.get(t.key))}`,
		);
	}
	for (const n of result.numeric) {
		if (!tagged.has(n.key)) lines.push(`  ${n.key}  ${pct(n.coverage)}${numericLine(n)}`);
	}
	if (result.count === 1) lines.push("  ⚠ profile of 1 feature — not a distribution");
	return `${lines.join("\n")}\n`;
}

function valueDesc(t: TagProfile): string {
	return t.cardinality <= 8 ? `[${t.values.join(", ")}]` : `${t.cardinality} values`;
}

function numericLine(n: NumericProfile | undefined): string {
	return n ? `  numeric ${n.min}–${n.max} (median ${n.median})` : "";
}

function pct(coverage: number): string {
	return `${Math.round(coverage * 100)}%`;
}
