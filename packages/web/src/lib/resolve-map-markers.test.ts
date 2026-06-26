/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { OverpassResultEntry } from "@pixies/core";
import { resolveMapMarkers } from "./resolve-map-markers.ts";
import type { TimelineItem } from "@/state/chat-reducer.ts";

function osmItem(toolCallId: string, data: OverpassResultEntry[]): TimelineItem {
	return {
		kind: "tool-call",
		toolCallId,
		toolName: "query_osm",
		args: {},
		status: "done",
		queued: false,
		resultText: null,
		result: { kind: "query_osm", entries: data },
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

test("queryRef not found and no query_osm to fall back on → null", () => {
	// A non-query_osm tool call and a user message: nothing to fall back to,
	// so a non-matching queryRef must still return null.
	const items: TimelineItem[] = [
		{
			kind: "tool-call",
			toolCallId: "call-1",
			toolName: "geocode",
			args: {},
			status: "done",
			queued: false,
			resultText: null,
			result: { kind: "geocode", entries: [] },
		},
		{ kind: "user-message", text: "hi" },
	];
	const result = resolveMapMarkers("nonexistent", undefined, items);
	expect(result).toBeNull();
});

test("referenced item has non-query_osm result → null", () => {
	const items: TimelineItem[] = [
		{
			kind: "tool-call",
			toolCallId: "call-1",
			toolName: "geocode",
			args: {},
			status: "done",
			queued: false,
			resultText: null,
			result: { kind: "geocode", entries: [] },
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

// --- Positional fallback (queryRef mismatch) ---

test("fallback — wrong queryRef resolves to nearest preceding query_osm (currentIndex given)", () => {
	const items: TimelineItem[] = [
		osmItem("call-1", SAMPLE_ENTRIES),
		{ kind: "assistant-message", text: "drawing map" },
	];
	// display_map sits at index 2; queryRef does not match.
	const result = resolveMapMarkers("hallucinated-id", undefined, items, 2);
	expect(result).not.toBeNull();
	expect(result).toHaveLength(3);
	expect(result![0]).toEqual({ lat: 59.3, lon: 18.1, label: "Cafe A" });
});

test("fallback — wrong queryRef resolves to last query_osm when currentIndex omitted", () => {
	const items: TimelineItem[] = [
		osmItem("call-1", SAMPLE_ENTRIES),
		{ kind: "assistant-message", text: "drawing map" },
	];
	const result = resolveMapMarkers("hallucinated-id", undefined, items);
	expect(result).not.toBeNull();
	expect(result).toHaveLength(3);
});

test("fallback — exact match still preferred over positional fallback", () => {
	const nearEntries: OverpassResultEntry[] = [
		{ type: "node", id: 1, lat: 1, lon: 1, name: "near" },
	];
	const farEntries: OverpassResultEntry[] = [{ type: "node", id: 2, lat: 2, lon: 2, name: "far" }];
	const items: TimelineItem[] = [
		osmItem("call-fallback", farEntries),
		osmItem("call-exact", nearEntries),
	];
	// queryRef matches the second item exactly → must use nearEntries, not fall back.
	const result = resolveMapMarkers("call-exact", undefined, items, 2);
	expect(result).toEqual([{ lat: 1, lon: 1, label: "near" }]);
});

test("fallback — bounded by currentIndex: ignores a query_osm at index > currentIndex", () => {
	const earlierEntries: OverpassResultEntry[] = [
		{ type: "node", id: 1, lat: 1, lon: 1, name: "earlier" },
	];
	const laterEntries: OverpassResultEntry[] = [
		{ type: "node", id: 2, lat: 2, lon: 2, name: "later" },
	];
	const items: TimelineItem[] = [
		osmItem("call-earlier", earlierEntries),
		osmItem("call-later", laterEntries),
	];
	// currentIndex=1 bounds the scan to only the first item.
	const result = resolveMapMarkers("hallucinated-id", undefined, items, 1);
	expect(result).toEqual([{ lat: 1, lon: 1, label: "earlier" }]);
});

test("fallback — elementIds filter applies to the fallback-resolved entries", () => {
	const items: TimelineItem[] = [osmItem("call-1", SAMPLE_ENTRIES)];
	const result = resolveMapMarkers("hallucinated-id", ["node/100", "node/300"], items, 1);
	expect(result).toHaveLength(2);
	expect(result![0]?.lat).toBe(59.3);
	expect(result![1]?.lat).toBe(59.5);
});

test("fallback — no query_osm anywhere before currentIndex → null", () => {
	const items: TimelineItem[] = [
		{ kind: "user-message", text: "hi" },
		{ kind: "assistant-message", text: "hello" },
	];
	const result = resolveMapMarkers("hallucinated-id", undefined, items, 2);
	expect(result).toBeNull();
});

test("fallback — multiple query_osm calls picks the nearest preceding one", () => {
	const firstEntries: OverpassResultEntry[] = [
		{ type: "node", id: 1, lat: 1, lon: 1, name: "first" },
	];
	const secondEntries: OverpassResultEntry[] = [
		{ type: "node", id: 2, lat: 2, lon: 2, name: "second" },
	];
	const thirdEntries: OverpassResultEntry[] = [
		{ type: "node", id: 3, lat: 3, lon: 3, name: "third" },
	];
	const items: TimelineItem[] = [
		osmItem("call-1", firstEntries),
		osmItem("call-2", secondEntries),
		osmItem("call-3", thirdEntries),
	];
	// display_map at index 3 → nearest preceding query_osm is call-3 (index 2).
	const result = resolveMapMarkers("hallucinated-id", undefined, items, 3);
	expect(result).toEqual([{ lat: 3, lon: 3, label: "third" }]);
});

test("fallback — empty items array → null", () => {
	const result = resolveMapMarkers("hallucinated-id", undefined, [], 0);
	expect(result).toBeNull();
});
