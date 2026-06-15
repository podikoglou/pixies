/// <reference types="bun" />
import { test, expect } from "bun:test";
import { parseToolResult, summarizeResult } from "./parse-result.ts";
import type { ToolResult } from "./parse-result.ts";

// ---- parseToolResult: geocode -------------------------------------------------

test("parseToolResult geocode — valid details with entries", () => {
	const details = {
		top: "Berlin (52.5,13.4)",
		data: [
			{ placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" },
			{ placeId: 2, lat: 52.6, lon: 13.5, name: "Berlin Mitte" },
		],
	};
	expect(parseToolResult("geocode", details)).toEqual({
		kind: "geocode",
		entries: [
			{ placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" },
			{ placeId: 2, lat: 52.6, lon: 13.5, name: "Berlin Mitte" },
		],
	});
});

test("parseToolResult geocode — valid with no results (empty data)", () => {
	expect(parseToolResult("geocode", { top: "no results", data: [] })).toEqual({
		kind: "geocode",
		entries: [],
	});
});

test("parseToolResult geocode — empty object collapses to empty", () => {
	expect(parseToolResult("geocode", {})).toEqual({ kind: "empty" });
});

test("parseToolResult geocode — null collapses to empty", () => {
	expect(parseToolResult("geocode", null)).toEqual({ kind: "empty" });
});

test("parseToolResult geocode — data is not an array collapses to empty", () => {
	expect(parseToolResult("geocode", { data: "not-array" })).toEqual({ kind: "empty" });
});

test("parseToolResult geocode — entry missing required name collapses to empty", () => {
	expect(parseToolResult("geocode", { data: [{ placeId: 1, lat: 0, lon: 0 }] })).toEqual({
		kind: "empty",
	});
});

// ---- parseToolResult: reverse_geocode ----------------------------------------

test("parseToolResult reverse_geocode — valid details", () => {
	const entry = { placeId: 9, lat: 1, lon: 2, name: "Eiffel Tower" };
	const result = parseToolResult("reverse_geocode", { name: "Eiffel Tower", data: entry });
	expect(result).toEqual({ kind: "reverse_geocode", entry });
});

test("parseToolResult reverse_geocode — undefined (real no-result case) collapses to empty", () => {
	expect(parseToolResult("reverse_geocode", undefined)).toEqual({ kind: "empty" });
});

test("parseToolResult reverse_geocode — missing data collapses to empty", () => {
	expect(parseToolResult("reverse_geocode", { name: "x" })).toEqual({ kind: "empty" });
});

// ---- parseToolResult: query_osm ----------------------------------------------

test("parseToolResult query_osm — valid details", () => {
	const entries = [
		{ type: "node" as const, id: 1, lat: 1, lon: 2, name: "A" },
		{ type: "way" as const, id: 2, name: "B" },
	];
	const result = parseToolResult("query_osm", { count: 2, data: entries });
	expect(result).toEqual({ kind: "query_osm", entries });
});

test("parseToolResult query_osm — missing count collapses to empty", () => {
	expect(parseToolResult("query_osm", { data: [] })).toEqual({ kind: "empty" });
});

test("parseToolResult query_osm — entry with invalid type literal collapses to empty", () => {
	expect(parseToolResult("query_osm", { count: 1, data: [{ type: "bogus", id: 1 }] })).toEqual({
		kind: "empty",
	});
});

// ---- parseToolResult: display_map --------------------------------------------

test("parseToolResult display_map — valid details", () => {
	const data = {
		markers: [
			{ lat: 1, lon: 2 },
			{ lat: 3, lon: 4, label: "Cafe" },
		],
	};
	expect(parseToolResult("display_map", { data })).toEqual({ kind: "display_map", data });
});

test("parseToolResult display_map — empty object (literal crash input) collapses to empty", () => {
	expect(parseToolResult("display_map", {})).toEqual({ kind: "empty" });
});

test("parseToolResult display_map — missing required markers collapses to empty", () => {
	expect(parseToolResult("display_map", { data: {} })).toEqual({ kind: "empty" });
});

test("parseToolResult display_map — marker missing required lon collapses to empty", () => {
	expect(parseToolResult("display_map", { data: { markers: [{ lat: 1 }] } })).toEqual({
		kind: "empty",
	});
});

// ---- parseToolResult: unknown tool name --------------------------------------

test("parseToolResult unknown tool name collapses to empty", () => {
	expect(parseToolResult("foo", { anything: true })).toEqual({ kind: "empty" });
});

test("parseToolResult empty string tool name collapses to empty", () => {
	expect(parseToolResult("", { data: { markers: [] } })).toEqual({ kind: "empty" });
});

// ---- summarizeResult ----------------------------------------------------------

test("summarizeResult geocode — reconstructs summary from entries[0]", () => {
	const result: ToolResult = {
		kind: "geocode",
		entries: [{ placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" }],
	};
	expect(summarizeResult(result)).toBe("Berlin (52.5,13.4)");
});

test("summarizeResult geocode — falls back to displayName when name is empty", () => {
	const result: ToolResult = {
		kind: "geocode",
		entries: [{ placeId: 1, lat: 1, lon: 2, name: "", displayName: "Foo Bar, City" }],
	};
	expect(summarizeResult(result)).toBe("Foo Bar (1,2)");
});

test("summarizeResult geocode — falls back to 'unknown' when name and displayName absent", () => {
	const result: ToolResult = {
		kind: "geocode",
		entries: [{ placeId: 1, lat: 1, lon: 2, name: "", displayName: undefined }],
	};
	expect(summarizeResult(result)).toBe("unknown (1,2)");
});

test("summarizeResult geocode — empty entries yields null", () => {
	const result: ToolResult = { kind: "geocode", entries: [] };
	expect(summarizeResult(result)).toBeNull();
});

test("summarizeResult reverse_geocode — returns entry.name", () => {
	const result: ToolResult = {
		kind: "reverse_geocode",
		entry: { placeId: 9, lat: 1, lon: 2, name: "Eiffel Tower" },
	};
	expect(summarizeResult(result)).toBe("Eiffel Tower");
});

test("summarizeResult query_osm — counts entries", () => {
	const result: ToolResult = {
		kind: "query_osm",
		entries: [
			{ type: "node", id: 1 },
			{ type: "way", id: 2 },
			{ type: "relation", id: 3 },
		],
	};
	expect(summarizeResult(result)).toBe("3 elements");
});

test("summarizeResult display_map — counts markers", () => {
	const result: ToolResult = {
		kind: "display_map",
		data: {
			markers: [
				{ lat: 1, lon: 2 },
				{ lat: 3, lon: 4 },
			],
		},
	};
	expect(summarizeResult(result)).toBe("2 marker(s)");
});

test("summarizeResult empty yields null", () => {
	expect(summarizeResult({ kind: "empty" })).toBeNull();
});

// ---- round-trip safety --------------------------------------------------------

test("parseToolResult -> summarizeResult never throws across all variants", () => {
	const inputs: Array<[string, unknown]> = [
		["geocode", {}],
		["geocode", null],
		["geocode", { top: "x", data: [{ placeId: 1, lat: 1, lon: 2, name: "X" }] }],
		["geocode", { top: "x", data: [] }],
		["reverse_geocode", undefined],
		["reverse_geocode", { data: { placeId: 1, lat: 1, lon: 2, name: "Y" } }],
		["query_osm", { count: 0, data: [] }],
		["display_map", {}],
		["display_map", { data: { markers: [{ lat: 1, lon: 2 }] } }],
		["unknown", { anything: true }],
	];
	for (const [name, details] of inputs) {
		const result = parseToolResult(name, details);
		// Must not throw; result type guarantees a string or null.
		const summary = summarizeResult(result);
		expect(summary === null || typeof summary === "string").toBe(true);
	}
});
