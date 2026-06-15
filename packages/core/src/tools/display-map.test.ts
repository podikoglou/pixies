/// <reference types="bun" />
import { test, expect } from "bun:test";
import { createDisplayMapTool } from "./display-map.ts";

const tool = createDisplayMapTool();

async function execute(params: Record<string, unknown>) {
	return tool.execute("test-call-id", params as never, undefined);
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
		text: "Displaying markers from query_osm call toolu_abc123 on map.",
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

test("XOR guard — both markers and queryRef throws", async () => {
	expect(
		execute({ markers: [{ lat: 1, lon: 2 }], queryRef: "toolu_abc" }),
	).rejects.toThrow("not both");
});

test("XOR guard — neither markers nor queryRef throws", async () => {
	expect(execute({})).rejects.toThrow("Provide either");
});

test("XOR guard — elementIds alone (no queryRef, no markers) throws", async () => {
	expect(execute({ elementIds: ["node/123"] })).rejects.toThrow("Provide either");
});
