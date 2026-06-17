/// <reference types="bun" />
import { test, expect } from "bun:test";
import { BudgetExceededError, OsmBusyError, OsmRemarkError } from "./errors.ts";

// Computed-message contract: these exact strings are depended on by logs,
// downstream tests, and the SSE `message` field. Byte-identical invariant.

test("OsmBusyError derives message from status and optional service", () => {
	expect(new OsmBusyError({ status: 429, service: "Overpass" }).message).toBe(
		"Overpass: OSM server busy (HTTP 429)",
	);
	expect(new OsmBusyError({ status: 503 }).message).toBe("OSM server busy (HTTP 503)");
});

test("OsmRemarkError derives its message from the remark (byte-identical to old throw)", () => {
	expect(new OsmRemarkError({ remark: "runtime error" }).message).toBe("Overpass: runtime error");
});

test("BudgetExceededError derives its message (byte-identical to old server string)", () => {
	expect(new BudgetExceededError({ used: 2, budget: 2 }).message).toBe(
		"conversation token budget (2) exceeded: used 2",
	);
});
