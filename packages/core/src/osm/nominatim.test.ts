/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { NominatimClient } from "./nominatim.ts";
import { OsmServerBusyError } from "./http.ts";
import { createOsmClients } from "../agent.ts";
import { type Logger } from "../logging/index.ts";

/** Build a JSON `Response`-like object osmFetch treats as a success. */
function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** A deferred the test resolves manually to gate the first in-flight fetch. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function makeClient(fetch: typeof globalThis.fetch, intervalMs = 40, logger?: Logger) {
	return new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch,
		intervalMs,
		logger,
	});
}

// ---- ADR-0004 invariant: one client serializes its requests ------------------

test("createOsmClients builds a single NominatimClient (ADR-0004 wiring)", () => {
	const clients = createOsmClients({
		overpassUrl: "https://overpass.example.com",
		nominatimUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
	});
	expect(clients.nominatim).toBeInstanceOf(NominatimClient);
	// One clients object ⇒ one nominatim ⇒ one queue ⇒ one chain (ADR-0004/0005).
	expect(clients.overpass).toBeDefined();
});

test("one NominatimClient serializes concurrent searches (ADR-0004 invariant)", async () => {
	const first = deferred<Response>();
	let firstStarted = false;
	let secondStarted = false;
	const controllableFetch = mock((_url: unknown, _init: unknown) => {
		if (!firstStarted) {
			firstStarted = true;
			return first.promise;
		}
		secondStarted = true;
		return Promise.resolve(jsonResponse([]));
	}) as unknown as typeof fetch;

	const client = makeClient(controllableFetch);

	const p1 = client.search("Berlin");
	const p2 = client.search("Vienna");

	// Flush microtasks so the first task has started and called fetch.
	await Promise.resolve();
	await Promise.resolve();
	expect(firstStarted).toBe(true);
	expect(secondStarted).toBe(false);
	expect(controllableFetch).toHaveBeenCalledTimes(1);

	// Release the first request — the second may now start.
	first.resolve(jsonResponse([]));
	await p1;
	await p2;
	expect(secondStarted).toBe(true);
	expect(controllableFetch).toHaveBeenCalledTimes(2);
});

// ---- abort ------------------------------------------------------------------

test("abort while a request is running rejects and surfaces the abort reason", async () => {
	const hanging = deferred<Response>();
	const fetchMock = mock(() => hanging.promise) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const controller = new AbortController();
	const p = client.search("Berlin", {}, controller.signal);
	controller.abort(new Error("user-cancelled"));

	await expect(p).rejects.toThrow("user-cancelled");
	// Cleanup: resolve the hanging fetch so no unhandled work lingers.
	hanging.resolve(jsonResponse([]));
});

// ---- OsmServerBusyError passthrough (CAVEAT #3) -----------------------------

test("OsmServerBusyError from osmFetch passes through unchanged", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	await expect(client.search("Berlin")).rejects.toBeInstanceOf(OsmServerBusyError);
});

test("generic non-abort error passes through unchanged", async () => {
	const fetchMock = mock(() =>
		Promise.reject(new Error("network down")),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	await expect(client.search("Berlin")).rejects.toThrow("network down");
});

// ---- interval spacing -------------------------------------------------------

test("serializes consecutive searches at least intervalMs apart", async () => {
	const starts: number[] = [];
	const fetchMock = mock(() => {
		starts.push(Date.now());
		return Promise.resolve(jsonResponse([]));
	}) as unknown as typeof fetch;
	const client = makeClient(fetchMock, 40);

	await client.search("Berlin");
	await client.search("Vienna");

	expect(starts).toHaveLength(2);
	// strict sliding window with interval=40ms → second fetch starts ≥ ~40ms
	// after the first. Allow jitter for setTimeout precision.
	expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(38);
});

// ---- reverse() smoke (uses the same limiter path) ---------------------------

test("reverse() returns the parsed result", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(
			jsonResponse({
				place_id: 1,
				lat: "52.5",
				lon: "13.4",
				display_name: "Berlin",
			}),
		),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const result = await client.reverse(52.5, 13.4);
	expect(result?.display_name).toBe("Berlin");
});
