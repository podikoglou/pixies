/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import { OSM_SERVER_BUSY_MESSAGE } from "../osm/http.ts";
import { OsmBusyError, OsmHttpError } from "../errors.ts";
import { createQueryOsmTool } from "./tool-query-osm.ts";
import { createReverseGeocodeTool } from "./tool-reverse-geocode.ts";
import { createGeocodeTool } from "./tool-geocode.ts";
import type { OverpassClient } from "../osm/overpass.ts";
import type { NominatimClient } from "../osm/nominatim.ts";

// ---- query_osm: busy handling -----------------------------------------------

test("query_osm: OsmBusyError returns normal result with busy message", async () => {
	const busyOverpass = {
		query: mock(() =>
			Promise.resolve(Result.err(new OsmBusyError({ status: 429, service: "Overpass" }))),
		),
	} as unknown as OverpassClient;
	const tool = createQueryOsmTool(busyOverpass);
	const result = await tool.execute("call-1", { query: "[out:json];node(1);out;" });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true });
	// Must NOT be flagged as an error — model should see it as a normal result
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("query_osm: generic error still propagates", async () => {
	const brokenOverpass = {
		query: mock(() =>
			Promise.resolve(Result.err(new OsmHttpError({ message: "Network failure" }))),
		),
	} as unknown as OverpassClient;
	const tool = createQueryOsmTool(brokenOverpass);
	await expect(tool.execute("call-2", { query: "[out:json];node(1);out;" })).rejects.toBeInstanceOf(
		OsmHttpError,
	);
});

// ---- reverse_geocode: busy handling -----------------------------------------

test("reverse_geocode: OsmBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		reverse: mock(() =>
			Promise.resolve(Result.err(new OsmBusyError({ status: 503, service: "Nominatim" }))),
		),
		search: mock(() =>
			Promise.resolve(Result.err(new OsmBusyError({ status: 503, service: "Nominatim" }))),
		),
	} as unknown as NominatimClient;
	const tool = createReverseGeocodeTool(busyNominatim);
	const result = await tool.execute("call-3", { lat: 52.5, lon: 13.4 });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true });
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("reverse_geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		reverse: mock(() =>
			Promise.resolve(Result.err(new OsmHttpError({ message: "Network failure" }))),
		),
		search: mock(() =>
			Promise.resolve(Result.err(new OsmHttpError({ message: "Network failure" }))),
		),
	} as unknown as NominatimClient;
	const tool = createReverseGeocodeTool(brokenNominatim);
	await expect(tool.execute("call-4", { lat: 52.5, lon: 13.4 })).rejects.toBeInstanceOf(
		OsmHttpError,
	);
});

// ---- geocode: busy handling -------------------------------------------------

test("geocode: OsmBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		search: mock(() =>
			Promise.resolve(Result.err(new OsmBusyError({ status: 429, service: "Nominatim" }))),
		),
		reverse: mock(() =>
			Promise.resolve(Result.err(new OsmBusyError({ status: 429, service: "Nominatim" }))),
		),
	} as unknown as NominatimClient;
	const tool = createGeocodeTool(busyNominatim);
	const result = await tool.execute("call-5", { query: "Berlin" });
	expect((result.content[0] as { text: string }).text).toBe(OSM_SERVER_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true, data: [] });
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		search: mock(() =>
			Promise.resolve(Result.err(new OsmHttpError({ message: "Network failure" }))),
		),
		reverse: mock(() =>
			Promise.resolve(Result.err(new OsmHttpError({ message: "Network failure" }))),
		),
	} as unknown as NominatimClient;
	const tool = createGeocodeTool(brokenNominatim);
	await expect(tool.execute("call-6", { query: "Berlin" })).rejects.toBeInstanceOf(OsmHttpError);
});
