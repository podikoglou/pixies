/// <reference types="bun" />
import { test, expect } from "bun:test";
import { NominatimBusyError } from "./clients/nominatim.ts";
import { OverpassBusyError, OverpassRemarkError } from "./clients/overpass.ts";
import { BudgetExceededError } from "./errors.ts";

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
