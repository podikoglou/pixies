/// <reference types="bun" />
import { expect, test } from "bun:test";
import { type NominatimClient, type OverpassClient, Result } from "@pixies/core";
import { MontyExecutor } from "./monty-executor.ts";

/** Minimal Nominatim stub: `search` returns a fixed hit list; `reverse` unused. */
function fakeNominatim(hits: Array<Record<string, unknown>>): NominatimClient {
	return {
		async search(_query: string, _opts: unknown, _signal?: AbortSignal) {
			return Result.ok(hits);
		},
		async reverse(_lat: number, _lon: number, _opts: unknown, _signal?: AbortSignal) {
			return Result.ok(null);
		},
	} as unknown as NominatimClient;
}

/** Minimal Overpass stub: returns a fixed element list. */
function fakeOverpass(elements: Array<Record<string, unknown>>): OverpassClient {
	return {
		async query(_query: string, _signal?: AbortSignal) {
			return Result.ok({ elements, truncate: false });
		},
	} as unknown as OverpassClient;
}

test("execute — display() with markers flows through to displays[]", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([]),
		overpass: fakeOverpass([]),
	});
	const code = `display(markers=[{"lat": 53.48, "lon": -2.24, "label": "Manchester"}])`;
	const result = await executor.execute(code, {});
	expect(Result.isError(result)).toBe(false);
	if (Result.isError(result)) return;
	expect(result.value.displays).toHaveLength(1);
	expect(result.value.displays[0]?.markers?.[0]?.lat).toBe(53.48);
});

test("execute — display(features=...) with a geocoded point flows through", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([
			{
				place_id: 1,
				name: "Manchester",
				lat: "53.4808",
				lon: "-2.2426",
				display_name: "Manchester, UK",
				type: "city",
			},
		]),
		overpass: fakeOverpass([]),
	});
	const code = `m = geocode("Manchester, UK")
display(markers=[{"lat": m["lat"], "lon": m["lon"], "label": m["name"]}])`;
	const result = await executor.execute(code, {});
	expect(Result.isError(result)).toBe(false);
	if (Result.isError(result)) return;
	expect(result.value.displays).toHaveLength(1);
	const marker = result.value.displays[0]?.markers?.[0];
	expect(marker?.lat).toBe(53.4808);
	expect(marker?.label).toBe("Manchester");
});

test("execute — variable persistence: first call stores value, second call uses it", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([
			{
				place_id: 1,
				name: "Manchester",
				lat: "53.4808",
				lon: "-2.2426",
				display_name: "Manchester, UK",
				type: "city",
			},
		]),
		overpass: fakeOverpass([]),
	});
	const first = await executor.execute(`m = geocode("Manchester, UK")`, {});
	expect(Result.isError(first)).toBe(false);
	const second = await executor.execute(
		`display(markers=[{"lat": m["lat"], "lon": m["lon"], "label": m["name"]}])`,
		{},
	);
	expect(Result.isError(second)).toBe(false);
	if (Result.isError(second)) return;
	expect(second.value.displays).toHaveLength(1);
	expect(second.value.displays[0]?.markers?.[0]?.label).toBe("Manchester");
});

test("execute — coding error returns Result.err, stdout preserved", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([]),
		overpass: fakeOverpass([]),
	});
	const result = await executor.execute(`1 + "foo"`, {});
	expect(Result.isError(result)).toBe(true);
});

test("execute — replay of prior display() call does NOT produce duplicate displays", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([
			{
				place_id: 1,
				name: "Manchester",
				lat: "53.4808",
				lon: "-2.2426",
				display_name: "Manchester, UK",
				type: "city",
			},
		]),
		overpass: fakeOverpass([]),
	});
	await executor.execute(
		`m = geocode("Manchester, UK")
display(markers=[{"lat": m["lat"], "lon": m["lon"], "label": m["name"]}])`,
		{},
	);
	const second = await executor.execute(`print(m["name"])`, {});
	if (Result.isError(second)) throw second.error;
	// Second call's own code did not call display() — only the replayed code did,
	// and replayed display() calls are skipped. Displays must be empty.
	expect(second.value.displays).toEqual([]);
});

test("execute — find_features auto-displays features without explicit display() call", async () => {
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([]),
		overpass: fakeOverpass([
			{
				type: "node",
				id: 1,
				lat: 53.48,
				lon: -2.24,
				tags: { name: "Stop A", highway: "bus_stop" },
			},
		]),
	});
	// find_features(types=["bus_stop"]) will query overpass; the stub returns one element.
	// Don't pass area — use around with a hardcoded point.
	const code = `bus_stops = find_features(types=["bus_stop"], area={"around": {"lat": 53.48, "lon": -2.24, "radius": 1000}})
print(bus_stops["count"])`;
	const result = await executor.execute(code, {});
	// eslint-disable-next-line no-console
	if (Result.isError(result)) console.log("ERR:", result.error.message);
	expect(Result.isError(result)).toBe(false);
	if (Result.isError(result)) return;
	expect(result.value.displays).toHaveLength(1);
	expect(result.value.displays[0]?.features).toHaveLength(1);
	expect(result.value.displays[0]?.features?.[0]?.name).toBe("Stop A");
});

test("execute — overpass_query auto-displays features without explicit display() call", async () => {
	// Regression: overpass_query was the only fetch primitive that did NOT
	// auto-display. With assistant text suppressed on the wire, a miscount
	// there rendered nothing (blank screen). It now auto-displays like the
	// other fetch primitives and returns a FeaturesEnvelope (features/count,
	// not elements).
	const executor = new MontyExecutor({
		nominatim: fakeNominatim([]),
		overpass: fakeOverpass([
			{
				type: "node",
				id: 7,
				lat: 53.48,
				lon: -2.24,
				tags: { name: "Node Seven", amenity: "cafe" },
			},
		]),
	});
	const code = `result = overpass_query("[out:json][timeout:5];node(7);out center;")
print(result["count"])`;
	const result = await executor.execute(code, {});
	if (Result.isError(result)) throw result.error;
	expect(result.value.displays).toHaveLength(1);
	expect(result.value.displays[0]?.features).toHaveLength(1);
	expect(result.value.displays[0]?.features?.[0]?.name).toBe("Node Seven");
});
