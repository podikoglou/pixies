/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import { ParseError } from "typebox/value";
import {
	NominatimBusyError,
	NominatimClient,
	NominatimHttpError,
	NominatimParseError,
} from "./nominatim.ts";
import { type Logger } from "../logging/index.ts";
import { ToolAbortedError } from "../errors.ts";

/** Build a JSON `Response` the Nominatim client treats as a success. */
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

// ---- config validation at construction (#230) --------------------------------

/** Minimal valid base config; individual tests add one bad knob. */
function baseConfig() {
	return {
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: (() => Promise.resolve(new Response("[]"))) as unknown as typeof globalThis.fetch,
	};
}

test("construction applies documented defaults when knobs are omitted (no undefined reaches p-queue)", async () => {
	const fetchMock = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;
	// Omit every defaulted knob; the client must still construct with valid
	// (defaulted) numbers rather than passing undefined into p-queue / LRUCache.
	const client = new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
	});

	const r = await client.search("Berlin");

	// A successful result proves every defaulted knob was a valid number —
	// undefined concurrency/interval/timeout would misbehave or throw here.
	expect(Result.isOk(r)).toBe(true);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("construction rejects out-of-bounds config at the boundary (fails fast, not inside p-queue)", () => {
	expect(() => new NominatimClient({ ...baseConfig(), concurrency: -5 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), concurrency: 0 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), intervalMs: 0 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), intervalCap: 0 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), cacheMaxEntries: -1 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), cacheTtlMs: -1 })).toThrow(ParseError);
	expect(() => new NominatimClient({ ...baseConfig(), timeoutMs: 0 })).toThrow(ParseError);
});

test("construction rejects a non-URL base URL at the boundary", () => {
	expect(() => new NominatimClient({ ...baseConfig(), baseUrl: "not-a-url" })).toThrow(ParseError);
});

test("construction rejects a malformed contact email at the boundary", () => {
	expect(() => new NominatimClient({ ...baseConfig(), contactEmail: "not-an-email" })).toThrow(
		ParseError,
	);
});

// ---- ADR-0004 invariant: one client serializes its requests ------------------

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

test("abort while a request is running returns Err(ToolAbortedError)", async () => {
	const hanging = deferred<Response>();
	const fetchMock = mock((_url: unknown, init: { signal?: AbortSignal }) => {
		const sig = init.signal;
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => reject(sig?.reason ?? new DOMException("Aborted", "AbortError"));
			if (sig?.aborted) return onAbort();
			sig?.addEventListener("abort", onAbort, { once: true });
			hanging.promise.then(resolve, reject);
		});
	}) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const controller = new AbortController();
	const p = client.search("Berlin", {}, controller.signal);
	// Let the rate-limit slot be acquired and fetch start before aborting.
	await Promise.resolve();
	await Promise.resolve();
	expect(fetchMock).toHaveBeenCalledTimes(1);

	controller.abort();

	const r = await p;
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("ToolAborted");
		expect(r.error).toBeInstanceOf(ToolAbortedError);
	}
	// Cleanup: resolve the hanging fetch so no unhandled work lingers.
	hanging.resolve(jsonResponse([]));
});

// ---- configurable timeoutMs --------------------------------------------------

test("timeoutMs aborts a hanging request when the configured window elapses", async () => {
	// A fetch that mimics real fetch: rejects with the signal's reason on abort.
	const fetchMock = mock((_url: unknown, init: { signal?: AbortSignal }) => {
		const sig = init.signal;
		return new Promise<Response>((_resolve, reject) => {
			const onAbort = () => reject(sig?.reason ?? new DOMException("Aborted", "AbortError"));
			if (sig?.aborted) return onAbort();
			sig?.addEventListener("abort", onAbort, { once: true });
		});
	}) as unknown as typeof fetch;
	const client = new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		intervalMs: 40,
		timeoutMs: 30,
	});

	const start = Date.now();
	const r = await client.search("Berlin");
	const elapsed = Date.now() - start;

	// The 30ms override took effect (not the 60s default): the request failed
	// within a second, proving the configured timeout fired.
	expect(Result.isError(r)).toBe(true);
	expect(elapsed).toBeLessThan(1000);
});

// ---- HTTP classification -----------------------------------------------------

test("500 non-busy response returns Err(NominatimHttpError)", async () => {
	const body = "internal server error";
	const fetchMock = mock(() =>
		Promise.resolve(new Response(body, { status: 500 })),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimHttp");
		expect(r.error).toBeInstanceOf(NominatimHttpError);
		expect(r.error).not.toBeInstanceOf(NominatimBusyError);
		if (!(r.error instanceof NominatimHttpError)) throw new Error("expected NominatimHttpError");
		expect(r.error.status).toBe(500);
		expect(r.error.body).toBe(body);
	}
});

test("busy body marker on non-ok response returns Err(NominatimBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(
			new Response("The server is probably too busy to handle your request", { status: 500 }),
		),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimBusy");
		expect(r.error).toBeInstanceOf(NominatimBusyError);
		if (!(r.error instanceof NominatimBusyError)) throw new Error("expected NominatimBusyError");
		expect(r.error.status).toBe(500);
	}
});

test("429 returns Err(NominatimBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimBusy");
		expect(r.error).toBeInstanceOf(NominatimBusyError);
	}
});

test("502 returns Err(NominatimBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("bad gateway", { status: 502 })),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimBusy");
		expect(r.error).toBeInstanceOf(NominatimBusyError);
	}
});

test("504 returns Err(NominatimBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("gateway timeout", { status: 504 })),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimBusy");
		expect(r.error).toBeInstanceOf(NominatimBusyError);
	}
});

test("generic non-abort error returns Err with the message", async () => {
	const fetchMock = mock(() =>
		Promise.reject(new Error("network down")),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);

	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) expect(r.error.message).toContain("network down");
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

	const r = await client.reverse(52.5, 13.4);
	expect(Result.isOk(r)).toBe(true);
	if (Result.isOk(r)) expect(r.value?.display_name).toBe("Berlin");
});

// ---- invalid-shape error contract (Value.Parse refactor) -----

test("search() returns Err(NominatimParseError) on invalid shape and tags the cause", async () => {
	const fetchMock = mock(
		() => Promise.resolve(jsonResponse([{ place_id: "not-a-number" }])), // bad place_id
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);
	const r = await client.search("Berlin");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimParse");
		expect(r.error).toBeInstanceOf(NominatimParseError);
		expect(r.error.message).toBe("Nominatim: invalid search response shape");
	}
});

test("reverse() returns Err(NominatimParseError) on invalid shape", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(
			jsonResponse({ lat: "52.5" /* missing required lon, display_name, place_id */ }),
		),
	) as unknown as typeof fetch;
	const client = makeClient(fetchMock);
	const r = await client.reverse(52.5, 13.4);
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("NominatimParse");
		expect(r.error).toBeInstanceOf(NominatimParseError);
		expect(r.error.message).toBe("Nominatim: invalid reverse response shape");
	}
});

// ---- response caching ------------------------------------------------

const SEARCH_RESULT = [{ place_id: 1, lat: "52.5", lon: "13.4", display_name: "Berlin" }];
const REVERSE_RESULT = { place_id: 1, lat: "52.5", lon: "13.4", display_name: "Berlin" };

/** Build a NominatimClient with caching enabled. */
function makeCachedClient(
	fetch: typeof globalThis.fetch,
	{
		max = 1000,
		ttl = 3_600_000,
		intervalMs = 40,
	}: { max?: number; ttl?: number; intervalMs?: number } = {},
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

/** Drain a search Result to its value (throws on Err so the test fails loudly). */
async function searchOk(client: NominatimClient, query: string) {
	const r = await client.search(query);
	if (Result.isError(r)) throw r.error;
	return r.value;
}

async function reverseOk(client: NominatimClient, lat: number, lon: number) {
	const r = await client.reverse(lat, lon);
	if (Result.isError(r)) throw r.error;
	return r.value;
}

test("search() caches a successful response — second identical query skips fetch", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await searchOk(client, "Berlin");
	await searchOk(client, "Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cache hit skips the rate-limit queue entirely (no fetch, no wait)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { intervalMs: 60_000 }); // huge interval

	await searchOk(client, "Berlin"); // populates cache
	const start = Date.now();
	await searchOk(client, "Berlin"); // cache hit — would block ~60s if it entered the limiter
	const elapsed = Date.now() - start;

	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(elapsed).toBeLessThan(1000);
});

test("different search queries are cache misses", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await searchOk(client, "Berlin");
	await searchOk(client, "Vienna");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("search cache key is case- and whitespace-insensitive", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await searchOk(client, "Berlin");
	await searchOk(client, "  BERLIN  ");

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("NominatimBusyError is NOT cached — retry hits the network again", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	const r1 = await client.search("Berlin");
	const r2 = await client.search("Berlin");
	expect(Result.isError(r1)).toBe(true);
	expect(Result.isError(r2)).toBe(true);
	if (Result.isError(r1)) expect(r1.error._tag).toBe("NominatimBusy");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("reverse() caches by quantized coordinates — sub-meter-nearby points hit", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(REVERSE_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await reverseOk(client, 52.51704, 13.38886);
	await reverseOk(client, 52.517041, 13.388861); // <1m away → same 5-decimal bucket

	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("reverse() with a different coordinate bucket is a miss", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(REVERSE_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	await reverseOk(client, 52.51704, 13.38886);
	await reverseOk(client, 48.2082, 16.3738); // different city

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("LRU eviction drops the least-recently-used entry at maxEntries", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { max: 2 });

	await searchOk(client, "Berlin"); // [Berlin]
	await searchOk(client, "Vienna"); // [Berlin, Vienna]
	await searchOk(client, "Paris"); // [Vienna, Paris] — Berlin evicted (LRU)
	await searchOk(client, "Berlin"); // miss → fetches again

	expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("TTL expiry evicts a stale entry", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock, { ttl: 30 }); // 30ms TTL

	await searchOk(client, "Berlin");
	await delay(40); // let the TTL lapse
	await searchOk(client, "Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("caching is disabled when cacheTtlMs is 0 (default client-layer behavior)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		intervalMs: 40,
		cacheTtlMs: 0,
		cacheMaxEntries: 1000,
	});

	await searchOk(client, "Berlin");
	await searchOk(client, "Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("caching is disabled when cacheMaxEntries is 0 (either knob disables)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse(SEARCH_RESULT)),
	) as unknown as typeof fetch;
	const client = new NominatimClient({
		baseUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		intervalMs: 40,
		cacheTtlMs: 3_600_000,
		cacheMaxEntries: 0,
	});

	await searchOk(client, "Berlin");
	await searchOk(client, "Berlin");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("reverse() does NOT cache a NominatimBusyError — retry hits the network again", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("too busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeCachedClient(fetchMock);

	const r1 = await client.reverse(52.51704, 13.38886);
	const r2 = await client.reverse(52.51704, 13.38886);
	expect(Result.isError(r1)).toBe(true);
	expect(Result.isError(r2)).toBe(true);
	if (Result.isError(r1)) expect(r1.error._tag).toBe("NominatimBusy");

	expect(fetchMock).toHaveBeenCalledTimes(2);
});
