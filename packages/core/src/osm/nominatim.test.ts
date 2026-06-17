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

// ---- invalid-shape error contract (pinned for #104 Value.Parse refactor) -----

test("search() throws on invalid shape and tags the cause", async () => {
	const fetchMock = mock(
		() => Promise.resolve(jsonResponse([{ place_id: "not-a-number" }])), // bad place_id
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);
	await expect(client.search("Berlin")).rejects.toThrow("Nominatim: invalid search response shape");
});

test("reverse() throws on invalid shape and tags the cause", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(
			jsonResponse({ lat: "52.5" /* missing required lon, display_name, place_id */ }),
		),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);
	await expect(client.reverse(52.5, 13.4)).rejects.toThrow(
		"Nominatim: invalid reverse response shape",
	);
});

// ---- response caching (#127) ------------------------------------------------

const SEARCH_RESULT = [{ place_id: 1, lat: "52.5", lon: "13.4", display_name: "Berlin" }];
const REVERSE_RESULT = { place_id: 1, lat: "52.5", lon: "13.4", display_name: "Berlin" };

/** Build a NominatimClient with caching enabled. */
function makeCachedClient(
	fetch: typeof globalThis.fetch,
	{ max = 1000, ttl = 3_600_000, intervalMs = 40 }: { max?: number; ttl?: number; intervalMs?: number } = {},
) {
	return new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch,
		intervalMs,
		cacheTtlMs: ttl,
		cacheMaxEntries: max,
	});
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("search() caches a successful response — second identical query skips fetch (#127)", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await client.search("Berlin");
	await client.search("Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cache hit skips the rate-limit queue entirely (no fetch, no wait) (#127)", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { intervalMs: 60_000 }); // huge interval

	await client.search("Berlin"); // populates cache
	const start = Date.now();
	await client.search("Berlin"); // cache hit — would block ~60s if it entered the limiter
	const elapsed = Date.now() - start;

	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(elapsed).toBeLessThan(1000);
});

test("different search queries are cache misses", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await client.search("Berlin");
	await client.search("Vienna");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("search cache key is case- and whitespace-insensitive", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await client.search("Berlin");
	await client.search("  BERLIN  ");

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("OsmServerBusyError is NOT cached — retry hits the network again", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await expect(client.search("Berlin")).rejects.toBeInstanceOf(OsmServerBusyError);
	await expect(client.search("Berlin")).rejects.toBeInstanceOf(OsmServerBusyError);

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("reverse() caches by quantized coordinates — sub-meter-nearby points hit", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(REVERSE_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await client.reverse(52.51704, 13.38886);
	await client.reverse(52.517041, 13.388861); // <1m away → same 5-decimal bucket

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("reverse() with a different coordinate bucket is a miss", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(REVERSE_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await client.reverse(52.51704, 13.38886);
	await client.reverse(48.2082, 16.3738); // different city

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("LRU eviction drops the least-recently-used entry at maxEntries", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { max: 2 });

	await client.search("Berlin"); // [Berlin]
	await client.search("Vienna"); // [Berlin, Vienna]
	await client.search("Paris"); // [Vienna, Paris] — Berlin evicted (LRU)
	await client.search("Berlin"); // miss → fetches again

	expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("TTL expiry evicts a stale entry", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { ttl: 30 }); // 30ms TTL

	await client.search("Berlin");
	await delay(40); // let the TTL lapse
	await client.search("Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("caching is disabled when cacheTtlMs is 0 (default client-layer behavior)", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse(SEARCH_RESULT))) as unknown as typeof fetch;
	const client = new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		intervalMs: 40,
		cacheTtlMs: 0,
		cacheMaxEntries: 1000,
	});

	await client.search("Berlin");
	await client.search("Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});
