/// <reference types="bun" />
import { test, expect } from "bun:test";
import { errorToToastCopy } from "./error-copy.ts";
import type { PixiesErrorTag } from "@pixies/core";

function copy(
	tag: PixiesErrorTag | undefined,
	defaultMessage = "fallback",
	details?: unknown,
): string {
	return errorToToastCopy({ tag, defaultMessage, details });
}

test("OsmBusy → friendly busy copy", () => {
	expect(copy("OsmBusy", "raw")).toBe("OpenStreetMap's servers are busy. Try again in a moment.");
});

test("OsmHttp / OsmParse / OsmRemark share the generic OSM-reach copy", () => {
	const expected = "We couldn't reach OpenStreetMap just now. Try again.";
	expect(copy("OsmHttp")).toBe(expected);
	expect(copy("OsmParse")).toBe(expected);
	expect(copy("OsmRemark")).toBe(expected);
});

test("ToolAborted falls back to the default message", () => {
	expect(copy("ToolAborted", "Stopped by user.")).toBe("Stopped by user.");
	expect(copy("ToolAborted", "")).toBe("Stopped.");
});

test("BudgetExceeded includes used/budget from details when available", () => {
	expect(copy("BudgetExceeded", "raw", { used: 5, budget: 10 })).toBe(
		"This conversation hit its token budget (5/10). Start a new conversation.",
	);
});

test("BudgetExceeded without details still renders", () => {
	expect(copy("BudgetExceeded", "raw")).toBe(
		"This conversation hit its token budget. Start a new conversation.",
	);
});

test("PromptConflict / ConversationNotFound render their copy", () => {
	expect(copy("PromptConflict")).toBe(
		"This conversation is already responding. Wait for it to finish.",
	);
	expect(copy("ConversationNotFound")).toBe("This conversation no longer exists.");
});

test("undefined tag (legacy server) falls back to the default message", () => {
	expect(copy(undefined, "legacy server message")).toBe("legacy server message");
});
