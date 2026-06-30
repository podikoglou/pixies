/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import fc from "fast-check";
import type { Logger } from "@pixies/core/logging";
import type { PostHogAnalyticsClient } from "./posthog.ts";
import { StreamInstrumentation } from "./stream-instrumentation.ts";

/**
 * Property tests for `StreamInstrumentation`.
 *
 * The contracts under test are derived from the class docstring (NOT from the
 * example tests):
 *
 *  - `total_tool_ms` (shipped on `agent stream done` / `agent stream
 *    disconnect`) is the sum of every completed tool execution's duration,
 *    regardless of outcome. A tool that started but never ended (in-flight at
 *    disconnect) contributes nothing.
 *
 *  - The primitive trace shipped on `tool call` preserves the input order of
 *    valid `{name, duration_ms}` entries (with repetition), collapses them
 *    into a `name → Σ duration_ms` timing map, filters malformed entries out,
 *    and is omitted entirely when no valid entry is present.
 *
 * NOTE on timing: `StreamInstrumentation` reads `Date.now()` for durations.
 * `bun:test`'s `setSystemTime` is process-global and churned by sibling test
 * files running concurrently, so a clock-controlled property is flaky in the
 * full suite. The `total_tool_ms` property instead asserts the CROSS-EVENT
 * conservation law (terminal aggregate == Σ per-tool captures) — which holds
 * for any clock state, since both sides derive from the same per-call
 * duration — and yields real time between start/end so durations are
 * non-trivial.
 */

interface Captured {
	distinctId: string;
	event: string;
	properties: Record<string, unknown>;
}

/** Spy analytics client that records captures without touching the network. */
function spyPostHog(): PostHogAnalyticsClient & { captures: Captured[] } {
	const captures: Captured[] = [];
	return {
		captures,
		capture: (m) => captures.push({ ...m, properties: { ...m.properties } }),
		shutdown: async () => {},
	};
}

/** Mock logger (only `error` is on any path exercised here). */
function mockLogger(): Logger {
	const errorSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	return { error: errorSpy } as unknown as Logger;
}

/** Resolve on the next macrotask so a real, non-zero duration elapses. */
function tick(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- total_tool_ms conservation -------------------------------------------

const scenario = fc.record({
	// Each entry is one completed tool execution with a varied outcome. The
	// outcome (error / busy / empty / success) must NOT excuse a tool from
	// contributing its duration to total_tool_ms.
	executions: fc.array(
		fc.record({
			isError: fc.boolean(),
			isBusy: fc.boolean(),
		}),
		{ maxLength: 4 },
	),
	terminal: fc.constantFrom<"complete" | "disconnect">("complete", "disconnect"),
	// A tool started but never ended (client aborts mid-call). It must
	// contribute zero — only recordToolEnd increments totalToolMs.
	hasInFlight: fc.boolean(),
});

test("total_tool_ms on the terminal event == Σ of completed tool-call durations, regardless of outcome", async () => {
	await fc.assert(
		fc.asyncProperty(scenario, async ({ executions, terminal, hasInFlight }) => {
			const posthog = spyPostHog();
			const instr = new StreamInstrumentation("conv", posthog, mockLogger());

			for (let i = 0; i < executions.length; i++) {
				const ex = executions[i]!;
				const id = `call-${i}`;
				instr.recordToolStart(id);
				await tick(1); // a real, non-zero wall-clock span
				const details = ex.isBusy ? { busy: true } : { displays: [], stdout: "" };
				instr.recordToolEnd(id, "execute_code", { details }, ex.isError);
			}

			if (hasInFlight) instr.recordToolStart("in-flight"); // never ended

			if (terminal === "complete") instr.complete();
			else instr.disconnect();

			const eventName = terminal === "complete" ? "agent stream done" : "agent stream disconnect";
			const cap = posthog.captures.find((c) => c.event === eventName);
			expect(cap).toBeDefined();

			// Every completed tool emits exactly one `tool call` capture carrying
			// its duration_ms; an in-flight tool emits none. The terminal
			// `total_tool_ms` must equal the sum of those parts — for every
			// outcome, since none is excused from the wall-clock cost. This
			// catches any refactor that made accumulation outcome-conditional.
			let sumToolCalls = 0;
			let toolCallCount = 0;
			for (const c of posthog.captures) {
				if (c.event === "tool call") {
					toolCallCount++;
					expect(Number.isInteger(c.properties.duration_ms)).toBe(true);
					sumToolCalls += c.properties.duration_ms as number;
				}
			}
			expect(toolCallCount).toBe(executions.length);
			expect(cap!.properties.total_tool_ms).toBe(sumToolCalls);
		}),
		{ numRuns: 40 },
	);
});

// ---- primitive trace aggregation ------------------------------------------

/**
 * The validity predicate the SUT applies to each primitive-trace entry. Mirrors
 * `extractPrimitiveTrace`: an entry contributes iff it is an object with a
 * string `name` and a number `duration_ms`. Defined here from the contract
 * (not imported) so the property acts as an independent oracle.
 */
function validEntry(e: unknown): { name: string; duration_ms: number } | null {
	if (typeof e !== "object" || e === null) return null;
	const o = e as Record<string, unknown>;
	if (typeof o.name !== "string") return null;
	if (typeof o.duration_ms !== "number") return null;
	return { name: o.name, duration_ms: o.duration_ms };
}

// A trace entry is either a well-formed {name, duration_ms} pair or one of the
// malformed shapes the contract must silently filter (wrong-typed duration,
// missing name, non-string name, or not an object at all).
const primitiveEntry: fc.Arbitrary<unknown> = fc.oneof(
	fc.record({
		name: fc.constantFrom("geocode", "find_features", "profile", "display"),
		duration_ms: fc.integer({ min: 0, max: 5000 }),
	}),
	fc.record({ name: fc.string({ maxLength: 8 }), duration_ms: fc.string({ maxLength: 4 }) }),
	fc.record({ duration_ms: fc.integer({ min: 0, max: 5000 }) }),
	fc.record({
		name: fc.integer({ min: -3, max: 3 }),
		duration_ms: fc.integer({ min: 0, max: 5000 }),
	}),
	fc.constant(null),
	fc.integer({ min: -5, max: 5 }),
);

// The details payload sometimes omits `primitives` entirely (non-execute_code
// tools / errored cells where pi-agent-core flattens details to `{}`).
const detailsPayload = fc.oneof(
	fc.record({
		primitives: fc.array(primitiveEntry, { maxLength: 10 }),
		displays: fc.constant([]),
		stdout: fc.constant(""),
	}),
	fc.record({ displays: fc.constant([]), stdout: fc.constant("") }),
);

test("primitive trace preserves order + repetition, collapses timings by name, and filters malformed entries", () => {
	fc.assert(
		fc.property(detailsPayload, (details) => {
			const posthog = spyPostHog();
			const instr = new StreamInstrumentation("conv", posthog, mockLogger());

			instr.recordToolStart("call-1");
			instr.recordToolEnd("call-1", "execute_code", { details }, false);

			// Compute the contract's expected trace straight from the predicate.
			const primitives = (details as { primitives?: unknown[] }).primitives ?? [];
			const valid = primitives
				.map(validEntry)
				.filter((v): v is { name: string; duration_ms: number } => v !== null);
			const expectedNames = valid.map((v) => v.name);
			const expectedTimings: Record<string, number> = {};
			for (const v of valid)
				expectedTimings[v.name] = (expectedTimings[v.name] ?? 0) + v.duration_ms;
			const anyValid = expectedNames.length > 0;

			const cap = posthog.captures.find((c) => c.event === "tool call");
			expect(cap).toBeDefined();
			const props = cap!.properties;

			if (anyValid) {
				expect(props.primitives).toEqual(expectedNames);
				expect(props.primitive_timings_ms).toEqual(expectedTimings);
				// Distinct names are exactly the timing keys (no phantoms either way).
				const distinctNames = new Set(expectedNames);
				expect(new Set(Object.keys(props.primitive_timings_ms as Record<string, number>))).toEqual(
					distinctNames,
				);
			} else {
				// No valid entries (or no primitives at all): neither key ships.
				expect(Object.prototype.hasOwnProperty.call(props, "primitives")).toBe(false);
				expect(Object.prototype.hasOwnProperty.call(props, "primitive_timings_ms")).toBe(false);
			}
		}),
	);
});
