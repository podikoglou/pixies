/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import {
	osmFetch,
	isServerBusyResponse,
	OsmServerBusyError,
	SERVER_BUSY_BODY_MARKERS,
	OSM_SERVER_BUSY_MESSAGE,
} from "./http.ts";

// ---- isServerBusyResponse ---------------------------------------------------

test("isServerBusyResponse: 429 returns true regardless of body", () => {
	expect(isServerBusyResponse(429, "anything")).toBe(true);
});

test("isServerBusyResponse: 503 returns true regardless of body", () => {
	expect(isServerBusyResponse(503, "anything")).toBe(true);
});

test("isServerBusyResponse: 200 with busy body returns true", () => {
	expect(isServerBusyResponse(200, "The server is probably too busy to handle your request")).toBe(true);
});

test("isServerBusyResponse: 200 with clean body returns false", () => {
	expect(isServerBusyResponse(200, '{"status":"ok"}')).toBe(false);
});

test("isServerBusyResponse: 500 with busy body returns true", () => {
	expect(isServerBusyResponse(500, "The server is probably too busy to handle your request")).toBe(true);
});

test("isServerBusyResponse: body containing <status>HTTP 503</status> returns true", () => {
	expect(
		isServerBusyResponse(200, '<osm><status>HTTP 503</status><meta>too busy</meta></osm>'),
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

// ---- OsmServerBusyError -----------------------------------------------------

test("OsmServerBusyError is an Error instance", () => {
	const err = new OsmServerBusyError(429, "Overpass");
	expect(err).toBeInstanceOf(Error);
});

test("OsmServerBusyError has correct name", () => {
	const err = new OsmServerBusyError(503, "Nominatim");
	expect(err.name).toBe("OsmServerBusyError");
});

test("OsmServerBusyError carries status", () => {
	const err = new OsmServerBusyError(429, "Overpass");
	expect(err.status).toBe(429);
});

test("OsmServerBusyError includes service name in message", () => {
	const err = new OsmServerBusyError(503, "Nominatim");
	expect(err.message).toContain("Nominatim");
});

// ---- osmFetch with server-busy responses ------------------------------------

test("osmFetch: 429 throws OsmServerBusyError", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	await expect(osmFetch("http://example.com", fakeFetch, { service: "Overpass" })).rejects.toThrow(
		OsmServerBusyError,
	);
});

test("osmFetch: 503 with busy body throws OsmServerBusyError", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(
			new Response("The server is probably too busy to handle your request", { status: 503 }),
		),
	) as unknown as typeof fetch;
	await expect(osmFetch("http://example.com", fakeFetch, { service: "Overpass" })).rejects.toThrow(
		OsmServerBusyError,
	);
});

test("osmFetch: 500 throws generic Error (not OsmServerBusyError)", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response("Internal Server Error", { status: 500 })),
	) as unknown as typeof fetch;
	await expect(osmFetch("http://example.com", fakeFetch, { service: "Overpass" })).rejects.toThrow(
		Error,
	);
	await expect(osmFetch("http://example.com", fakeFetch, { service: "Overpass" })).rejects.not.toThrow(
		OsmServerBusyError,
	);
});

test("osmFetch: 200 returns Response (body unconsumed)", async () => {
	const fakeFetch = mock(() =>
		Promise.resolve(new Response('{"elements":[]}', { status: 200 })),
	) as unknown as typeof fetch;
	const res = await osmFetch("http://example.com", fakeFetch);
	expect(res.status).toBe(200);
	// Body should be consumable (not yet read by osmFetch)
	await expect(res.json()).resolves.toEqual({ elements: [] });
});

// ---- OSM_SERVER_BUSY_MESSAGE -------------------------------------------------

test("OSM_SERVER_BUSY_MESSAGE is a non-empty string", () => {
	expect(typeof OSM_SERVER_BUSY_MESSAGE).toBe("string");
	expect(OSM_SERVER_BUSY_MESSAGE.length).toBeGreaterThan(0);
});

test("OSM_SERVER_BUSY_MESSAGE contains do not retry guidance", () => {
	expect(OSM_SERVER_BUSY_MESSAGE.toLowerCase()).toMatch(/do\s+not\s+retry/);
});
