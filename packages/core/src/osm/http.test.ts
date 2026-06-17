/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import {
	osmFetch,
	isServerBusyResponse,
	SERVER_BUSY_BODY_MARKERS,
	OSM_SERVER_BUSY_MESSAGE,
} from "./http.ts";
import { OsmBusyError, OsmHttpError } from "../errors.ts";

// ---- isServerBusyResponse ---------------------------------------------------

test("isServerBusyResponse: 429 returns true regardless of body", () => {
	expect(isServerBusyResponse(429, "anything")).toBe(true);
});

test("isServerBusyResponse: 503 returns true regardless of body", () => {
	expect(isServerBusyResponse(503, "anything")).toBe(true);
});

test("isServerBusyResponse: 200 with busy body returns true", () => {
	expect(isServerBusyResponse(200, "The server is probably too busy to handle your request")).toBe(
		true,
	);
});

test("isServerBusyResponse: 200 with clean body returns false", () => {
	expect(isServerBusyResponse(200, '{"status":"ok"}')).toBe(false);
});

test("isServerBusyResponse: 500 with busy body returns true", () => {
	expect(isServerBusyResponse(500, "The server is probably too busy to handle your request")).toBe(
		true,
	);
});

test("isServerBusyResponse: body containing <status>HTTP 503</status> returns true", () => {
	expect(
		isServerBusyResponse(200, "<osm><status>HTTP 503</status><meta>too busy</meta></osm>"),
	).toBe(true);
});

test("isServerBusyResponse: 504 returns false", () => {
	expect(isServerBusyResponse(504, "gateway timeout")).toBe(false);
});

test("isServerBusyResponse: 404 returns false", () => {
	expect(isServerBusyResponse(404, "not found")).toBe(false);
});

test("isServerBusyResponse: SERVER_BUSY_BODY_MARKERS is non-empty", () => {
	expect(SERVER_BUSY_BODY_MARKERS.length).toBeGreaterThan(0);
});

// ---- osmFetch Result contract (issue #109) ----------------------------------

test("osmFetch: 429 returns Err(OsmBusyError)", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const result = await osmFetch("http://example.com", fakeFetch, { service: "Overpass" });
	expect(Result.isError(result)).toBe(true);
	if (Result.isError(result)) {
		expect(result.error._tag).toBe("OsmBusy");
		expect(result.error).toBeInstanceOf(OsmBusyError);
		expect(result.error.status).toBe(429);
		expect(result.error.service).toBe("Overpass");
	}
});

test("osmFetch: 503 with busy body returns Err(OsmBusyError)", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(
			new Response("The server is probably too busy to handle your request", { status: 503 }),
		),
	) as unknown as typeof fetch;
	const result = await osmFetch("http://example.com", fakeFetch, { service: "Overpass" });
	expect(Result.isError(result)).toBe(true);
	if (Result.isError(result)) expect(result.error._tag).toBe("OsmBusy");
});

test("osmFetch: 500 returns Err(OsmHttpError), not OsmBusyError", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response("Internal Server Error", { status: 500 })),
	) as unknown as typeof fetch;
	const result = await osmFetch("http://example.com", fakeFetch, { service: "Overpass" });
	expect(Result.isError(result)).toBe(true);
	if (Result.isError(result)) {
		expect(result.error._tag).toBe("OsmHttp");
		expect(result.error).toBeInstanceOf(OsmHttpError);
		expect(result.error).not.toBeInstanceOf(OsmBusyError);
	}
});

test("osmFetch: network failure returns Err(OsmHttpError) wrapping the cause", async () => {
	const fakeFetch = mock(() =>
		Promise.reject(new Error("network down")),
	) as unknown as typeof fetch;
	const result = await osmFetch("http://example.com", fakeFetch, { service: "Nominatim" });
	expect(Result.isError(result)).toBe(true);
	if (Result.isError(result)) {
		expect(result.error._tag).toBe("OsmHttp");
		expect(result.error.cause).toBeInstanceOf(Error);
		expect(result.error.message).toContain("network error");
	}
});

test("osmFetch: 200 returns Ok(Response) (body unconsumed)", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response('{"elements":[]}', { status: 200 })),
	) as unknown as typeof fetch;
	const result = await osmFetch("http://example.com", fakeFetch);
	expect(Result.isOk(result)).toBe(true);
	if (Result.isOk(result)) {
		expect(result.value.status).toBe(200);
		// Body should be consumable (not yet read by osmFetch)
		await expect(result.value.json()).resolves.toEqual({ elements: [] });
	}
});

// ---- OSM_SERVER_BUSY_MESSAGE -------------------------------------------------

test("OSM_SERVER_BUSY_MESSAGE is a non-empty string", () => {
	expect(typeof OSM_SERVER_BUSY_MESSAGE).toBe("string");
	expect(OSM_SERVER_BUSY_MESSAGE.length).toBeGreaterThan(0);
});

test("OSM_SERVER_BUSY_MESSAGE contains do not retry guidance", () => {
	expect(OSM_SERVER_BUSY_MESSAGE.toLowerCase()).toMatch(/do\s+not\s+retry/);
});
