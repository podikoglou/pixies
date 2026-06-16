/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { createRateLimiter } from "./rate-limiter.ts";
import { OsmServerBusyError } from "./http.ts";

/** A deferred promise the test resolves manually to gate a running task. */
function blocker<T = string>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("concurrency:1 serializes — second fn does not start until the first resolves", async () => {
	const limiter = createRateLimiter({ concurrency: 1 });
	const a = blocker<string>();
	let aStarted = false;
	let bStarted = false;

	const pA = limiter.withRateLimit(async () => {
		aStarted = true;
		return a.promise;
	});
	const pB = limiter.withRateLimit(async () => {
		bStarted = true;
		return "b";
	});

	// Flush microtasks so task A's run() has fully started.
	await Promise.resolve();
	expect(aStarted).toBe(true);
	expect(bStarted).toBe(false);

	a.resolve("a");
	await pA;
	await pB;
	expect(bStarted).toBe(true);
});

test("abort-while-queued rejects and the task never runs (CAVEAT #1)", async () => {
	const limiter = createRateLimiter({ concurrency: 1 });
	const a = blocker<string>();

	// Occupy the single slot.
	const pA = limiter.withRateLimit(async () => a.promise);

	const controller = new AbortController();
	const fnB = mock(() => Promise.resolve("b"));
	const pB = limiter.withRateLimit(fnB, controller.signal);

	controller.abort(new Error("boom"));
	await expect(pB).rejects.toThrow("boom");
	expect(fnB).toHaveBeenCalledTimes(0);

	a.resolve("a");
	await pA;
});

test("abort-while-queued with no reason normalizes to signal.reason (DOMException) — still rejects", async () => {
	const limiter = createRateLimiter({ concurrency: 1 });
	const a = blocker<string>();
	const pA = limiter.withRateLimit(async () => a.promise);

	const controller = new AbortController();
	const fnB = mock(() => Promise.resolve("b"));
	const pB = limiter.withRateLimit(fnB, controller.signal);

	controller.abort();
	// No explicit reason: signal.reason is the platform AbortError DOMException;
	// the limiter must still reject (and never run the task).
	await expect(pB).rejects.toThrow();
	expect(fnB).toHaveBeenCalledTimes(0);

	a.resolve("a");
	await pA;
});

test("emits {type:'queued'} when contended, then {type:'running'} once started", async () => {
	const limiter = createRateLimiter({ concurrency: 1 });
	const a = blocker<string>();
	const progressA: string[] = [];
	const progressB: string[] = [];

	const pA = limiter.withRateLimit(async () => a.promise, undefined, {
		onProgress: (p) => progressA.push(p.type),
	});
	// Task A started immediately (no contention) → only "running".
	await Promise.resolve();
	expect(progressA).toEqual(["running"]);

	const pB = limiter.withRateLimit(
		async () => "b",
		undefined,
		{ onProgress: (p) => progressB.push(p.type) },
	);
	// Task B is contended → "queued" emitted at enqueue, not yet "running".
	expect(progressB).toEqual(["queued"]);

	a.resolve("a");
	await pA;
	await pB;
	// After A frees the slot, B runs → "running".
	expect(progressB).toEqual(["queued", "running"]);
});

test("strict interval spacing — tasks start at least `interval` ms apart", async () => {
	const limiter = createRateLimiter({ concurrency: 1, intervalCap: 1, interval: 30, strict: true });
	const starts: number[] = [];
	const record = async () => {
		starts.push(Date.now());
		return starts.length;
	};

	await limiter.withRateLimit(record);
	await limiter.withRateLimit(record);
	await limiter.withRateLimit(record);

	expect(starts).toHaveLength(3);
	// Strict sliding window guarantees spacing >= interval between consecutive
	// starts. Allow 2ms jitter for setTimeout precision under load.
	expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(28);
	expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(28);
});

test("genuine errors pass through untouched (CAVEAT #3)", async () => {
	const limiter = createRateLimiter({ concurrency: 1 });
	const busy = new OsmServerBusyError(429, "Nominatim");

	await expect(
		limiter.withRateLimit(async () => {
			throw busy;
		}),
	).rejects.toBe(busy);

	const generic = new Error("network down");
	await expect(
		limiter.withRateLimit(async () => {
			throw generic;
		}),
	).rejects.toBe(generic);
});

test("exposes the underlying p-queue instance", () => {
	const limiter = createRateLimiter({ concurrency: 2, intervalCap: 2, interval: 1000 });
	expect(limiter.queue).toBeDefined();
	expect(limiter.queue.concurrency).toBe(2);
});
