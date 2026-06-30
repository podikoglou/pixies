/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Value } from "typebox/value";
import { ErrorData } from "./sse-events.ts";

// --- ErrorData backward-compatibility ---------------------------
// The `errorTag` / `details` fields are additive; legacy { message }-only
// payloads must still validate so old clients keep working.

test("ErrorData accepts a legacy { message } payload (back-compat)", () => {
	expect(Value.Check(ErrorData, { message: "boom" })).toBe(true);
});

test("ErrorData accepts the enriched { message, errorTag, details } payload", () => {
	expect(
		Value.Check(ErrorData, { message: "boom", errorTag: "OverpassBusy", details: { status: 429 } }),
	).toBe(true);
});
