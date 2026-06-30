/// <reference types="bun" />
import { expect, test } from "bun:test";
import fc from "fast-check";
import { StdoutCollector } from "./stdout-collector.ts";

/**
 * Property tests for `StdoutCollector`.
 *
 * The contract under test is derived from the class docstring (NOT from the
 * implementation): the collector bounds STORED output to `budget` chars.
 * Pushed fragments are stored in arrival order — the last storable one may be
 * sliced at the boundary — and anything that does not fit is dropped but
 * counted. `finish()` appends a trailing truncation marker IFF the total
 * pushed strictly exceeds the budget, and that marker reports the exact count
 * of dropped chars.
 *
 * Two input distributions are used:
 *  - a broad random one (arbitrary fragments) for the structural/accounting
 *    laws that hold everywhere;
 *  - a boundary-targeted one that pins `total` to `budget + small offset`,
 *    because the marker-threshold contract lives entirely on that boundary
 *    and uniform-random generation almost never lands on it exactly.
 */

// Fragments may be any string EXCEPT one containing the marker delimiter, so
// the appended marker is unambiguous to detect. (The model printing the exact
// truncation banner verbatim is an adversarial case outside this contract.)
const fragment = fc.string({ maxLength: 20 }).filter((s) => !s.includes("[stdout truncated"));
const fragments = fc.array(fragment, { minLength: 0, maxLength: 8 });
const budget = fc.integer({ min: 0, max: 50 });

interface ParsedFinish {
	body: string;
	hasMarker: boolean;
	/** Dropped-char count as declared by the marker; null when no marker. */
	omitted: number | null;
}

/**
 * Split `finish()` output into the stored body and (if present) the marker's
 * declared omitted count. The marker is introduced by the literal
 * "\n[stdout truncated", which the fragment generator excludes, so any
 * occurrence unambiguously identifies the appended marker.
 */
function parseFinish(out: string): ParsedFinish {
	const markerStart = out.indexOf("\n[stdout truncated");
	if (markerStart === -1) return { body: out, hasMarker: false, omitted: null };
	const markerText = out.slice(markerStart);
	const m = markerText.match(/~(\d+) chars omitted/);
	return { body: out.slice(0, markerStart), hasMarker: true, omitted: m ? Number(m[1]) : null };
}

test("StdoutCollector — stored body is a prefix of the push; accounting is exact in both branches", () => {
	fc.assert(
		fc.property(budget, fragments, (b, frags) => {
			let total = 0;
			for (const f of frags) total += f.length;
			const concat = frags.join("");
			const collector = new StdoutCollector(b);
			frags.forEach((f) => collector.push(f));
			const parsed = parseFinish(collector.finish());

			// Structural invariant: the collector never reorders, invents, or
			// grows — it only ever trims the tail. So the stored body is always
			// a string-prefix of the unbounded concatenation, and never exceeds
			// the budget.
			expect(concat.startsWith(parsed.body)).toBe(true);
			expect(parsed.body.length).toBeLessThanOrEqual(b);

			if (parsed.hasMarker) {
				// Every dropped char is accounted for: reported omitted == total
				// minus what was stored, and a genuine truncation drops ≥ 1.
				expect(parsed.omitted).toBe(total - parsed.body.length);
				expect(parsed.omitted as number).toBeGreaterThanOrEqual(1);
			} else {
				// No truncation: the body IS the full concatenation.
				expect(parsed.body).toBe(concat);
			}
		}),
	);
});

test("StdoutCollector — marker present iff total pushed strictly exceeds budget", () => {
	// Boundary-targeted: pin total to budget + offset so the threshold is
	// sampled densely on both sides AND exactly on it. Empty fragments are
	// interleaved because Monty streams separator/newline fragments of length
	// zero — they must not, on their own, flip the collector into truncation.
	const boundaryScenario = fc.record({
		budget: fc.integer({ min: 0, max: 40 }),
		offset: fc.integer({ min: -1, max: 3 }), // total = budget + offset
		emptyBefore: fc.boolean(),
		emptyAfter: fc.boolean(),
	});

	fc.assert(
		fc.property(boundaryScenario, ({ budget: b, offset, emptyBefore, emptyAfter }) => {
			const total = Math.max(0, b + offset);
			const collector = new StdoutCollector(b);
			if (emptyBefore) collector.push("");
			collector.push("x".repeat(total));
			if (emptyAfter) collector.push("");
			const { hasMarker } = parseFinish(collector.finish());

			// The marker means "you saw a sliver, not the whole output." That is
			// true exactly when the pushed total could not fit — i.e. strictly
			// exceeds the budget. A total equal to or under the budget must not
			// produce a marker, even when an empty fragment follows a full body.
			expect(hasMarker).toBe(total > b);
		}),
	);
});
