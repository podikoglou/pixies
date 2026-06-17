/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import { OverpassClient } from "./overpass.ts";
import { type Logger } from "../logging/index.ts";
import { ToolAbortedError, OsmBusyError, OsmParseError } from "../errors.ts";

/** Build a JSON `Response` osmFetch treats as a success. */
function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** A deferred the test resolves manually to gate an in-flight fetch. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function makeOverpass(fetch: typeof globalThis.fetch, logger?: Logger) {
	return new OverpassClient({
		baseUrl: "https://overpass.example.com/api/interpreter",
		userAgent: "pixies-test",
		fetch,
		logger,
	});
}

/** A fetch that returns a fresh controllable blocker for every call. */
function blockingFetch(): {
	fetch: typeof globalThis.fetch;
	blockers: Deferred<Response>[];
} {
	const blockers: Deferred<Response>[] = [];
	const fetchFn = mock(() => {
		const d = deferred<Response>();
		blockers.push(d);
		return d.promise;
	}) as unknown as typeof globalThis.fetch;
	return { fetch: fetchFn, blockers };
}

/** Resolve all outstanding blockers so hanging queries can settle. */
function releaseAll(blockers: Deferred<Response>[]) {
	for (const b of blockers) b.resolve(jsonResponse({ elements: [] }));
}

// ---- max 2 concurrent -------------------------------------------------------

test("max 2 concurrent — third query is queued and does not start while two run", async () => {
	const { fetch: fetchMock, blockers } = blockingFetch();
	const client = makeOverpass(fetchMock);

	const p1 = client.query("[out:json];node(1);out;");
	const p2 = client.query("[out:json];node(2);out;");
	const c3 = new AbortController();
	const p3 = client.query("[out:json];node(3);out;", c3.signal);

	await Promise.resolve();
	await Promise.resolve();
	// Exactly two fetches started; the third is queued behind the cap.
	expect(fetchMock).toHaveBeenCalledTimes(2);

	// Abort the queued third (also avoids waiting on the 1s rate window for
	// cleanup) and assert it never reached fetch.
	c3.abort();
	const r3 = await p3;
	expect(Result.isError(r3)).toBe(true);
	if (Result.isError(r3)) {
		expect(r3.error._tag).toBe("ToolAborted");
		expect(r3.error).toBeInstanceOf(ToolAbortedError);
	}
	expect(fetchMock).toHaveBeenCalledTimes(2);

	releaseAll(blockers);
	await p1;
	await p2;
});

// ---- abort while queued -----------------------------------------------------

test("abort while queued returns Err and the task never runs", async () => {
	const { fetch: fetchMock, blockers } = blockingFetch();
	const client = makeOverpass(fetchMock);

	// Fill both concurrency slots.
	const p1 = client.query("[out:json];node(1);out;");
	const p2 = client.query("[out:json];node(2);out;");
	await Promise.resolve();
	await Promise.resolve();
	expect(fetchMock).toHaveBeenCalledTimes(2);

	const c = new AbortController();
	const p3 = client.query("[out:json];node(3);out;", c.signal);
	c.abort();
	const r3 = await p3;
	expect(Result.isError(r3)).toBe(true);
	if (Result.isError(r3)) expect(r3.error._tag).toBe("ToolAborted");
	expect(fetchMock).toHaveBeenCalledTimes(2);

	releaseAll(blockers);
	await p1;
	await p2;
});

// ---- abort while running threads the signal into osmFetch -------------------

test("abort while running returns Err and the signal threaded to fetch is aborted", async () => {
	const seenSignals: AbortSignal[] = [];
	const blocker = deferred<Response>();
	const fetchMock = mock((_url: unknown, init: { signal?: AbortSignal }) => {
		if (init.signal) seenSignals.push(init.signal);
		return blocker.promise;
	}) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);

	const c = new AbortController();
	const p = client.query("[out:json];node(1);out;", c.signal);
	await Promise.resolve();
	await Promise.resolve();
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(seenSignals[0]!.aborted).toBe(false);

	c.abort();
	const r = await p;
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) expect(r.error._tag).toBe("ToolAborted");
	// The parent signal is merged into the fetch signal inside osmFetch; once
	// the parent aborts, the merged signal passed to fetch is aborted too.
	expect(seenSignals[0]!.aborted).toBe(true);

	blocker.resolve(jsonResponse({ elements: [] }));
});

// ---- OsmBusyError (429) surfaces as Err (CAVEAT #3) -------------------------

test("429 returns Err(OsmBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OsmBusy");
		expect(r.error).toBeInstanceOf(OsmBusyError);
	}
});

// ---- success ----------------------------------------------------------------

test("query returns parsed OverpassResponse on success", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse({ elements: [{ type: "node", id: 1, lat: 1, lon: 2 }] })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isOk(r)).toBe(true);
	if (Result.isOk(r)) expect(r.value.elements).toHaveLength(1);
});

// ---- invalid-shape error contract (pinned for #104 Value.Parse refactor) -----

test("query() returns Err(OsmParseError) on invalid shape and tags the cause", async () => {
	const fetchMock = mock(
		() => Promise.resolve(jsonResponse({ elements: "not-an-array" })), // bad elements
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OsmParse");
		expect(r.error).toBeInstanceOf(OsmParseError);
		expect(r.error.message).toBe("Overpass: invalid response shape");
		expect(r.error.cause).toBeDefined();
	}
});
