/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";

import {
	NominatimBusyError,
	NominatimHttpError,
	NOMINATIM_BUSY_MESSAGE,
	type NominatimClient,
} from "../clients/nominatim.ts";
import {
	OverpassBusyError,
	OverpassHttpError,
	OVERPASS_BUSY_MESSAGE,
	type OverpassClient,
} from "../clients/overpass.ts";
import { queryOsmModule } from "./tool-query-osm.ts";
import { reverseGeocodeModule } from "./tool-reverse-geocode.ts";
import { geocodeModule } from "./tool-geocode.ts";

// ---- query_osm: busy handling -----------------------------------------------

test("query_osm: OverpassBusyError returns normal result with busy message", async () => {
	const busyOverpass = {
		query: mock(() => Promise.resolve(Result.err(new OverpassBusyError({ status: 429 })))),
	} as unknown as OverpassClient;
	const tool = queryOsmModule.build({ overpass: busyOverpass });
	const result = await tool.execute("call-1", { query: "[out:json];node(1);out;" });
	expect((result.content[0] as { text: string }).text).toBe(OVERPASS_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true });
	// Must NOT be flagged as an error — model should see it as a normal result
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("query_osm: generic error still propagates", async () => {
	const brokenOverpass = {
		query: mock(() =>
			Promise.resolve(Result.err(new OverpassHttpError({ message: "Network failure" }))),
		),
	} as unknown as OverpassClient;
	const tool = queryOsmModule.build({ overpass: brokenOverpass });
	await expect(tool.execute("call-2", { query: "[out:json];node(1);out;" })).rejects.toBeInstanceOf(
		OverpassHttpError,
	);
});

// ---- reverse_geocode: busy handling -----------------------------------------

test("reverse_geocode: NominatimBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		reverse: mock(() => Promise.resolve(Result.err(new NominatimBusyError({ status: 503 })))),
		search: mock(() => Promise.resolve(Result.err(new NominatimBusyError({ status: 503 })))),
	} as unknown as NominatimClient;
	const tool = reverseGeocodeModule.build({ nominatim: busyNominatim });
	const result = await tool.execute("call-3", { lat: 52.5, lon: 13.4 });
	expect((result.content[0] as { text: string }).text).toBe(NOMINATIM_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true });
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("reverse_geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		reverse: mock(() =>
			Promise.resolve(Result.err(new NominatimHttpError({ message: "Network failure" }))),
		),
		search: mock(() =>
			Promise.resolve(Result.err(new NominatimHttpError({ message: "Network failure" }))),
		),
	} as unknown as NominatimClient;
	const tool = reverseGeocodeModule.build({ nominatim: brokenNominatim });
	await expect(tool.execute("call-4", { lat: 52.5, lon: 13.4 })).rejects.toBeInstanceOf(
		NominatimHttpError,
	);
});

// ---- geocode: busy handling -------------------------------------------------

test("geocode: NominatimBusyError returns normal result with busy message", async () => {
	const busyNominatim = {
		search: mock(() => Promise.resolve(Result.err(new NominatimBusyError({ status: 429 })))),
		reverse: mock(() => Promise.resolve(Result.err(new NominatimBusyError({ status: 429 })))),
	} as unknown as NominatimClient;
	const tool = geocodeModule.build({ nominatim: busyNominatim });
	const result = await tool.execute("call-5", { query: "Berlin" });
	expect((result.content[0] as { text: string }).text).toBe(NOMINATIM_BUSY_MESSAGE);
	expect(result.details).toEqual({ busy: true, data: [] });
	expect((result as { isError?: unknown }).isError).toBeUndefined();
});

test("geocode: generic error still propagates", async () => {
	const brokenNominatim = {
		search: mock(() =>
			Promise.resolve(Result.err(new NominatimHttpError({ message: "Network failure" }))),
		),
		reverse: mock(() =>
			Promise.resolve(Result.err(new NominatimHttpError({ message: "Network failure" }))),
		),
	} as unknown as NominatimClient;
	const tool = geocodeModule.build({ nominatim: brokenNominatim });
	await expect(tool.execute("call-6", { query: "Berlin" })).rejects.toBeInstanceOf(
		NominatimHttpError,
	);
});
