/// <reference types="bun" />
import { test, expect } from "bun:test";
import { summarizeResult } from "./summarize-result.ts";
import type { ToolResult } from "@pixies/core";

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

test("summarizeResult never throws across all variants", () => {
	const results: ToolResult[] = [
		{ kind: "geocode", entries: [{ placeId: 1, lat: 1, lon: 2, name: "X" }] },
		{ kind: "geocode", entries: [] },
		{ kind: "reverse_geocode", entry: { placeId: 1, lat: 1, lon: 2, name: "Y" } },
		{ kind: "query_osm", entries: [] },
		{ kind: "display_map", data: { markers: [{ lat: 1, lon: 2 }] } },
		{ kind: "empty" },
	];
	for (const result of results) {
		const summary = summarizeResult(result);
		expect(summary === null || typeof summary === "string").toBe(true);
	}
});
