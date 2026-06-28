/// <reference types="bun" />
import { test, expect } from "bun:test";
import { ResultStore } from "./result-store.ts";
import type { StoredResult } from "./result-store.ts";

const stored = (id: string, n: number): StoredResult => ({
	toolCallId: id,
	toolName: "find_features",
	timestamp: 0,
	elements: Array.from({ length: n }, (_, i) => ({ id: `${id}/${i}`, lat: i, lon: i })),
});

test("set/get/has — roundtrip keyed by tool call ID", () => {
	const s = new ResultStore();
	s.set(stored("tc_01", 3));
	expect(s.has("tc_01")).toBe(true);
	expect(s.has("tc_02")).toBe(false);
	expect(s.get("tc_01")?.elements).toHaveLength(3);
	expect(s.get("tc_02")).toBeUndefined();
});

test("LRU eviction — oldest entry is evicted when the cap is reached", () => {
	const s = new ResultStore(3);
	s.set(stored("a", 1));
	s.set(stored("b", 1));
	s.set(stored("c", 1));
	// Touch "a" so it becomes most-recently-used; "b" is now oldest.
	s.get("a");
	s.set(stored("d", 1));
	expect(s.has("a")).toBe(true);
	expect(s.has("b")).toBe(false);
	expect(s.has("c")).toBe(true);
	expect(s.has("d")).toBe(true);
	expect(s.size).toBe(3);
});

test("delete — removes the entry", () => {
	const s = new ResultStore();
	s.set(stored("a", 1));
	s.delete("a");
	expect(s.has("a")).toBe(false);
});
