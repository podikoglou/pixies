/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { OverpassResultEntry } from "@pixies/core";
import { resolveMapMarkers } from "./resolve-map-markers.ts";
import type { TimelineItem } from "@/state/chat-reducer.ts";

function osmItem(
	toolCallId: string,
	data: OverpassResultEntry[],
): TimelineItem {
	return {
		kind: "tool-call",
		toolCallId,
		toolName: "query_osm",
		args: {},
		status: "done",
		queued: false,
		resultText: null,
		resultData: data,
		summary: null,
	};
}

const SAMPLE_ENTRIES: OverpassResultEntry[] = [
	{ type: "node", id: 100, lat: 59.3, lon: 18.1, name: "Cafe A" },
	{ type: "way", id: 200, lat: 59.4, lon: 18.2 },
	{ type: "node", id: 300, lat: 59.5, lon: 18.3, name: "Cafe C" },
	{ type: "relation", id: 400 },
];

test("happy path — resolves markers from query_osm item", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).not.toBeNull();
	expect(result).toHaveLength(3);
	expect(result![0]).toEqual({ lat: 59.3, lon: 18.1, label: "Cafe A" });
	expect(result![1]).toEqual({ lat: 59.4, lon: 18.2 });
	expect(result![2]).toEqual({ lat: 59.5, lon: 18.3, label: "Cafe C" });
});

test("filters out entries without lat/lon", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).not.toBeNull();
	expect(result!.some((m) => m.lat === undefined)).toBe(false);
});

test("unnamed entries have no label key", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("call-1", undefined, items);
	const unnamed = result!.find((m) => m.lat === 59.4);
	expect(unnamed).toBeDefined();
	expect("label" in unnamed!).toBe(false);
});

test("queryRef not found in items → null", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("nonexistent", undefined, items);
	expect(result).toBeNull();
});

test("referenced toolCallId is not query_osm → null", () => {
	const items: TimelineItem[] = [
		{
			kind: "tool-call",
			toolCallId: "call-1",
			toolName: "geocode",
			args: {},
			status: "done",
			queued: false,
			resultText: null,
			resultData: [],
			summary: null,
		},
	];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).toBeNull();
});

test("resultData is not an array → null", () => {
	const items: TimelineItem[] = [
		{
			kind: "tool-call",
			toolCallId: "call-1",
			toolName: "query_osm",
			args: {},
			status: "done",
			queued: false,
			resultText: null,
			resultData: { not: "an array" },
			summary: null,
		},
	];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).toBeNull();
});

test("elementIds filter — keeps only matching type/id entries", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("call-1", ["node/100", "node/300"], items);
	expect(result).toHaveLength(2);
	expect(result![0]?.lat).toBe(59.3);
	expect(result![1]?.lat).toBe(59.5);
});

test("elementIds filter — no matches → empty array", () => {
	const items = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("call-1", ["node/999"], items);
	expect(result).toEqual([]);
});

test("empty query_osm result → empty array", () => {
	const items = [osmItem("call-1", [])];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).toEqual([]);
});

test("searches through multiple items to find the match", () => {
	const items: TimelineItem[] = [
		osmItem("call-0", [{ type: "node", id: 1, lat: 0, lon: 0 }]),
		{ kind: "user-message", text: "hello" },
		osmItem("call-1", SAMPLE_ENTRIES),
		{ kind: "assistant-message", text: "hi" },
	];
	const result = resolveMapMarkers("call-1", undefined, items);
	expect(result).not.toBeNull();
	expect(result).toHaveLength(3);
});
