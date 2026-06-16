/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { OsmServerBusyError, OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { createQueryOsmTool } from "./query-osm.ts";
import { createReverseGeocodeTool } from "./reverse-geocode.ts";
import { createGeocodeTool } from "./geocode.ts";
import type { OverpassClient } from "../osm/overpass.ts";
import type { NominatimClient } from "../osm/nominatim.ts";

// ---- query_osm: busy handling -----------------------------------------------

test("query_osm: OsmServerBusyError returns normal result with busy message", async () => {
	const busyOverpass = {
		query: mock(() => Promise.reject(new OsmServerBusyError(429, "Overpass"))),
	} as unknown as OverpassClient;
	const tool = createQueryOsmTool(busyOverpass);
	const result = await tool.execute("call-1", { query: "[out:json];node(1);out;" });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	expect(result.details).toBeUndefined();
	// Must NOT be flagged as an error — model should see it as a normal result
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("query_osm: generic error still propagates", async () => {
	const brokenOverpass = {
		query: mock(() => Promise.reject(new Error("Network failure"))),
	} as unknown as OverpassClient;
	const tool = createQueryOsmTool(brokenOverpass);
	await expect(tool.execute("call-2", { query: "[out:json];node(1);out;" })).rejects.toThrow(
		"Network failure",
	);
});

// ---- reverse_geocode: busy handling -----------------------------------------

test("reverse_geocode: OsmServerBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		reverse: mock(() => Promise.reject(new OsmServerBusyError(503, "Nominatim"))),
		search: mock(() => Promise.reject(new OsmServerBusyError(503, "Nominatim"))),
	} as unknown as NominatimClient;
	const tool = createReverseGeocodeTool(busyNominatim);
	const result = await tool.execute("call-3", { lat: 52.5, lon: 13.4 });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	expect(result.details).toBeUndefined();
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("reverse_geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		reverse: mock(() => Promise.reject(new Error("Network failure"))),
		search: mock(() => Promise.reject(new Error("Network failure"))),
	} as unknown as NominatimClient;
	const tool = createReverseGeocodeTool(brokenNominatim);
	await expect(tool.execute("call-4", { lat: 52.5, lon: 13.4 })).rejects.toThrow("Network failure");
});

// ---- geocode: busy handling -------------------------------------------------

test("geocode: OsmServerBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		search: mock(() => Promise.reject(new OsmServerBusyError(429, "Nominatim"))),
		reverse: mock(() => Promise.reject(new OsmServerBusyError(429, "Nominatim"))),
	} as unknown as NominatimClient;
	const tool = createGeocodeTool(busyNominatim);
	const result = await tool.execute("call-5", { query: "Berlin" });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	// geocode details does not accept undefined, so we use a sentinel
	expect(result.details).toEqual({ top: "osm server busy", data: [] });
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		search: mock(() => Promise.reject(new Error("Network failure"))),
		reverse: mock(() => Promise.reject(new Error("Network failure"))),
	} as unknown as NominatimClient;
	const tool = createGeocodeTool(brokenNominatim);
	await expect(tool.execute("call-6", { query: "Berlin" })).rejects.toThrow("Network failure");
});
