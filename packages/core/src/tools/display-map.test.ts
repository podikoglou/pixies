/// <reference types="bun" />
import { test, expect } from "bun:test";
import { displayMapModule } from "./tool-display-map.ts";
import { TurnCoordinator } from "./dependency-graph.ts";
import { ResultStore } from "./result-store.ts";

const tool = displayMapModule.build({
	coordinator: new TurnCoordinator(),
	store: new ResultStore(),
});

async function execute(params: Parameters<typeof tool.execute>[1]) {
	return tool.execute("test-call-id", params, undefined);
}

test("inline markers mode — returns markers and count in content", async () => {
	const result = await execute({
		markers: [
			{ lat: 59.3, lon: 18.1 },
			{ lat: 59.4, lon: 18.2, label: "Cafe" },
		],
	});
	expect(result.details.data.markers).toHaveLength(2);
	expect(result.details.data.markers[0]).toEqual({ lat: 59.3, lon: 18.1 });
	expect(result.details.data.markers[1]).toEqual({ lat: 59.4, lon: 18.2, label: "Cafe" });
	expect(result.content[0]).toMatchObject({ text: "Displaying 2 marker(s) on map." });
});

test("inline markers mode — forwards bounds", async () => {
	const bounds = { minlat: 59, minlon: 18, maxlat: 60, maxlon: 19 };
	const result = await execute({ markers: [{ lat: 1, lon: 2 }], bounds });
	expect(result.details.data.bounds).toEqual(bounds);
});

test("queryRef mode — returns empty markers, queryRef, and elementIds", async () => {
	const result = await execute({
		queryRef: "toolu_abc123",
		elementIds: ["node/123", "way/456"],
	});
	expect(result.details.data.markers).toEqual([]);
	expect(result.details.data.queryRef).toBe("toolu_abc123");
	expect(result.details.data.elementIds).toEqual(["node/123", "way/456"]);
	expect(result.content[0]).toMatchObject({
		text: "Displaying markers from query_osm / find_features call toolu_abc123 on map.",
	});
});

test("queryRef mode — elementIds omitted is undefined in details", async () => {
	const result = await execute({ queryRef: "toolu_abc" });
	expect(result.details.data.elementIds).toBeUndefined();
});

test("queryRef mode — forwards bounds", async () => {
	const bounds = { minlat: 1, minlon: 2, maxlat: 3, maxlon: 4 };
	const result = await execute({ queryRef: "toolu_abc", bounds });
	expect(result.details.data.bounds).toEqual(bounds);
});

test("elementsRef mode — forwards ref id", async () => {
	const result = await execute({ elementsRef: "toolu_def" });
	expect(result.details.data.elementsRef).toBe("toolu_def");
	expect(result.content[0]).toMatchObject({
		text: "Displaying elements from result toolu_def on map.",
	});
});

test("pairsRef mode — forwards ref id", async () => {
	const result = await execute({ pairsRef: "toolu_xyz" });
	expect(result.details.data.pairsRef).toBe("toolu_xyz");
	expect(result.content[0]).toMatchObject({
		text: "Displaying spatial_join pairs from toolu_xyz on map (points + targets + connecting lines).",
	});
});

test("XOR guard — markers + queryRef throws", async () => {
	expect(execute({ markers: [{ lat: 1, lon: 2 }], queryRef: "toolu_abc" })).rejects.toThrow(
		"not multiple",
	);
});

test("XOR guard — neither markers nor any ref throws", async () => {
	expect(execute({})).rejects.toThrow("Provide one of");
});

test("XOR guard — elementIds alone (no ref, no markers) throws", async () => {
	expect(execute({ elementIds: ["node/123"] })).rejects.toThrow("Provide one of");
});
