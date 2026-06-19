/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import { createQueryOsmTool } from "./tool-query-osm.ts";
import { createGeocodeTool } from "./tool-geocode.ts";
import { MAX_CONTENT_LINES } from "./limits.ts";
import type { OverpassClient } from "../osm/overpass.ts";
import type { NominatimClient, NominatimResult } from "../osm/nominatim.ts";

function makeOverpassElements(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		type: "node" as const,
		id: i + 1,
		lat: 52.5 + i * 0.01,
		lon: 13.4 + i * 0.01,
		tags: { name: `Place ${i + 1}` },
	}));
}

function makeNominatimResults(count: number): NominatimResult[] {
	return Array.from({ length: count }, (_, i) => ({
		place_id: i + 1,
		lat: `${52.5 + i * 0.01}`,
		lon: `${13.4 + i * 0.01}`,
		display_name: `Place ${i + 1}, City, Country`,
	}));
}

function mockOverpass(elements: ReturnType<typeof makeOverpassElements>): OverpassClient {
	return {
		query: mock(() => Promise.resolve(Result.ok({ elements, version: 0.6 }))),
	} as unknown as OverpassClient;
}

function mockNominatim(results: NominatimResult[]): NominatimClient {
	return {
		search: mock(() => Promise.resolve(Result.ok(results))),
		reverse: mock(() => Promise.resolve(Result.ok(results[0] ?? null))),
	} as unknown as NominatimClient;
}

// ---- query_osm: truncation ----------------------------------------------------

test("query_osm: under limit — all results in content", async () => {
	const elements = makeOverpassElements(10);
	const tool = createQueryOsmTool(mockOverpass(elements));
	const result = await tool.execute("call-1", { query: "[out:json];node(1);out;" });
	const text = (result.content[0] as { text: string }).text;
	// 10 lines (one per element), no truncation footer
	expect(text.split("\n").length).toBe(10);
	expect(text).not.toInclude("…and");
	expect(result.details).toEqual({ count: 10, data: expect.any(Array) });
	expect((result.details as { data: unknown[] }).data).toHaveLength(10);
});

test("query_osm: over limit — content truncated, details complete", async () => {
	const count = MAX_CONTENT_LINES + 100;
	const elements = makeOverpassElements(count);
	const tool = createQueryOsmTool(mockOverpass(elements));
	const result = await tool.execute("call-2", { query: "[out:json];node(1);out;" });
	const text = (result.content[0] as { text: string }).text;
	const lines = text.split("\n");
	// MAX_CONTENT_LINES + 1 footer line
	expect(lines.length).toBe(MAX_CONTENT_LINES + 1);
	expect(lines[MAX_CONTENT_LINES]).toInclude(`…and 100 more results`);
	expect(text).toInclude("All results are shown on the map");
	// details.data is full set
	expect((result.details as { data: unknown[] }).data).toHaveLength(count);
});

test("query_osm: exactly at limit — no truncation", async () => {
	const elements = makeOverpassElements(MAX_CONTENT_LINES);
	const tool = createQueryOsmTool(mockOverpass(elements));
	const result = await tool.execute("call-3", { query: "[out:json];node(1);out;" });
	const text = (result.content[0] as { text: string }).text;
	expect(text.split("\n").length).toBe(MAX_CONTENT_LINES);
	expect(text).not.toInclude("…and");
	expect((result.details as { data: unknown[] }).data).toHaveLength(MAX_CONTENT_LINES);
});

test("query_osm: empty result — no truncation", async () => {
	const tool = createQueryOsmTool(mockOverpass([]));
	const result = await tool.execute("call-5", { query: "[out:json];node(1);out;" });
	expect((result.content[0] as { text: string }).text).toBe("No results.");
	expect(result.details).toEqual({ count: 0, data: [] });
});

// ---- geocode: truncation -------------------------------------------------------

test("geocode: under limit — all results in content", async () => {
	const results = makeNominatimResults(10);
	const tool = createGeocodeTool(mockNominatim(results));
	const result = await tool.execute("call-6", { query: "Berlin" });
	const text = (result.content[0] as { text: string }).text;
	expect(text.split("\n").length).toBe(10);
	expect(text).not.toInclude("…and");
	expect((result.details as { data: unknown[] }).data).toHaveLength(10);
});

test("geocode: over limit — content truncated, details complete", async () => {
	const count = MAX_CONTENT_LINES + 20;
	const results = makeNominatimResults(count);
	const tool = createGeocodeTool(mockNominatim(results));
	const result = await tool.execute("call-7", { query: "Berlin" });
	const text = (result.content[0] as { text: string }).text;
	const lines = text.split("\n");
	expect(lines.length).toBe(MAX_CONTENT_LINES + 1);
	expect(lines[MAX_CONTENT_LINES]).toInclude("…and 20 more results");
	expect((result.details as { data: unknown[] }).data).toHaveLength(count);
});

test("geocode: exactly at limit — no truncation", async () => {
	const results = makeNominatimResults(MAX_CONTENT_LINES);
	const tool = createGeocodeTool(mockNominatim(results));
	const result = await tool.execute("call-8", { query: "Berlin" });
	const text = (result.content[0] as { text: string }).text;
	expect(text.split("\n").length).toBe(MAX_CONTENT_LINES);
	expect(text).not.toInclude("…and");
});

test("geocode: top field still set when truncated", async () => {
	const results = makeNominatimResults(MAX_CONTENT_LINES + 10);
	const tool = createGeocodeTool(mockNominatim(results));
	const result = await tool.execute("call-9", { query: "Berlin" });
	expect((result.details as { top: string }).top).toBe("Place 1 (52.5,13.4)");
});
