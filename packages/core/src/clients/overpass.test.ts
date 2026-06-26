/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { Result } from "better-result";
import {
	OverpassBusyError,
	OverpassClient,
	OverpassHttpError,
	OverpassParseError,
	OverpassRemarkError,
} from "./overpass.ts";
import { type Logger } from "../logging/index.ts";
import { ToolAbortedError } from "../errors.ts";

/** Build a JSON `Response` the Overpass client treats as a success. */
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

// ---- abort while running threads the signal into fetch --------------------

test("abort while running returns Err and the signal threaded to fetch is aborted", async () => {
	const seenSignals: AbortSignal[] = [];
	const blocker = deferred<Response>();
	const fetchMock = mock((_url: unknown, init: { signal?: AbortSignal }) => {
		const sig = init.signal;
		if (sig) seenSignals.push(sig);
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => reject(sig?.reason ?? new DOMException("Aborted", "AbortError"));
			if (sig?.aborted) return onAbort();
			sig?.addEventListener("abort", onAbort, { once: true });
			blocker.promise.then(resolve, reject);
		});
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
	// The parent signal is merged into the fetch signal inside fetchOverpassResponse;
	// once the parent aborts, the merged signal passed to fetch is aborted too.
	expect(seenSignals[0]!.aborted).toBe(true);

	blocker.resolve(jsonResponse({ elements: [] }));
});

// ---- HTTP classification -----------------------------------------------------

test("500 non-busy response returns Err(OverpassHttpError)", async () => {
	const body = "internal server error";
	const fetchMock = mock(() =>
		Promise.resolve(new Response(body, { status: 500 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);

	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassHttp");
		expect(r.error).toBeInstanceOf(OverpassHttpError);
		expect(r.error).not.toBeInstanceOf(OverpassBusyError);
		if (!(r.error instanceof OverpassHttpError)) throw new Error("expected OverpassHttpError");
		expect(r.error.status).toBe(500);
		expect(r.error.body).toBe(body);
	}
});

test("busy body marker on non-ok response returns Err(OverpassBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("<status>HTTP 503</status>", { status: 500 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);

	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassBusy");
		expect(r.error).toBeInstanceOf(OverpassBusyError);
		if (!(r.error instanceof OverpassBusyError)) throw new Error("expected OverpassBusyError");
		expect(r.error.status).toBe(500);
	}
});

test("429 returns Err(OverpassBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("busy", { status: 429 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassBusy");
		expect(r.error).toBeInstanceOf(OverpassBusyError);
	}
});

test("502 returns Err(OverpassBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("bad gateway", { status: 502 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassBusy");
		expect(r.error).toBeInstanceOf(OverpassBusyError);
	}
});

test("504 returns Err(OverpassBusyError)", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(new Response("gateway timeout", { status: 504 })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassBusy");
		expect(r.error).toBeInstanceOf(OverpassBusyError);
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

// ---- invalid-shape error contract (Value.Parse refactor) -----

test("query() returns Err(OverpassParseError) on invalid shape and tags the cause", async () => {
	const fetchMock = mock(
		() => Promise.resolve(jsonResponse({ elements: "not-an-array" })), // bad elements
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassParse");
		expect(r.error).toBeInstanceOf(OverpassParseError);
		expect(r.error.message).toBe("Overpass: invalid response shape");
		expect(r.error.cause).toBeDefined();
	}
});

test("query() returns Err(OverpassRemarkError) when Overpass returns a remark", async () => {
	const fetchMock = mock(() =>
		Promise.resolve(jsonResponse({ elements: [], remark: "runtime error" })),
	) as unknown as typeof fetch;
	const client = makeOverpass(fetchMock);
	const r = await client.query("[out:json];node(1);out;");
	expect(Result.isError(r)).toBe(true);
	if (Result.isError(r)) {
		expect(r.error._tag).toBe("OverpassRemark");
		expect(r.error).toBeInstanceOf(OverpassRemarkError);
		expect(r.error.message).toBe("Overpass: runtime error");
	}
});
