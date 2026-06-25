/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Value } from "typebox/value";
import { NominatimBusyError } from "./clients/nominatim.ts";
import { OverpassBusyError, OverpassRemarkError } from "./clients/overpass.ts";
import { BudgetExceededError, PixiesErrorTagSchema } from "./errors.ts";

// Computed-message contract: these exact strings are depended on by logs,
// downstream tests, and the SSE `message` field. Byte-identical invariant.

test("service busy errors derive messages from status", () => {
	expect(new OverpassBusyError({ status: 429 }).message).toBe(
		"Overpass: OSM server busy (HTTP 429)",
	);
	expect(new NominatimBusyError({ status: 503 }).message).toBe(
		"Nominatim: OSM server busy (HTTP 503)",
	);
});

test("OverpassRemarkError derives its message from the remark (byte-identical to old throw)", () => {
	expect(new OverpassRemarkError({ remark: "runtime error" }).message).toBe(
		"Overpass: runtime error",
	);
});

test("BudgetExceededError derives its message (byte-identical to old server string)", () => {
	expect(new BudgetExceededError({ used: 2, budget: 2 }).message).toBe(
		"conversation token budget (2) exceeded: used 2",
	);
});

// PixiesErrorTagSchema is the wire-trust boundary for the SSE `errorTag`
// field. The drift guard in errors.ts pins its literals to the TaggedError
// union, so a representative sample is enough here — exhaustive enumeration
// would be over-specification.

test("PixiesErrorTagSchema accepts every known Pixies tag", () => {
	for (const tag of [
		"OverpassBusy",
		"OverpassRemark",
		"NominatimBusy",
		"NominatimParse",
		"BudgetExceeded",
		"ToolAborted",
		"ConversationNotFound",
		"InvalidTranscript",
	]) {
		expect(Value.Check(PixiesErrorTagSchema, tag)).toBe(true);
	}
});

test("PixiesErrorTagSchema rejects unknown / malformed tag strings", () => {
	expect(Value.Check(PixiesErrorTagSchema, "NotARealTag")).toBe(false);
	// Tag convention is PascalCase without the `Error` suffix (errors.ts:16).
	expect(Value.Check(PixiesErrorTagSchema, "OverpassBusyError")).toBe(false);
	expect(Value.Check(PixiesErrorTagSchema, "overpassbusy")).toBe(false);
});
