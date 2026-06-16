import PQueue from "p-queue";
import type { ToolProgress } from "../tools/progress.ts";
import { silentLogger, type Logger } from "../logging/index.ts";

/**
 * Progress callbacks invoked by {@link createRateLimiter}. Emits typed
 * {@link ToolProgress} signals: `{ type: "queued" }` before waiting for a
 * rate-limit slot, `{ type: "running" }` once the slot is acquired.
 */
export interface RateLimitCallbacks {
	onProgress?: (progress: ToolProgress) => void;
}

export interface RateLimiterOptions {
	/** Max concurrent in-flight tasks. Maps to p-queue `concurrency`. */
	concurrency: number;
	/** Max tasks started per `interval` window. Maps to p-queue `intervalCap`. */
	intervalCap?: number;
	/** Window length (ms) for `intervalCap`. Maps to p-queue `interval`. */
	interval?: number;
	/**
	 * Sliding-window mode (p-queue `strict`): no more than `intervalCap` tasks
	 * start within any rolling `interval` window, preventing bursts at window
	 * boundaries. Used by Nominatim to stay strictly under 1 req/s.
	 */
	strict?: boolean;
	/** Service name embedded in queue-depth/wait log lines (e.g. "Nominatim"). */
	service?: string;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
}

export interface RateLimiter {
	/**
	 * Run `fn` through the shared rate-limit queue.
	 *
	 * @param fn     Async work to gate (e.g. an `osmFetch`).
	 * @param signal Optional abort signal. When aborted **while queued**, the
	 *               task is removed and the promise rejects — `fn` never runs.
	 *               When aborted **while running**, the rejection is normalized
	 *               to `signal.reason ?? new Error("Aborted")` to preserve the
	 *               shape Nominatim historically emitted.
	 * @param cb     Optional progress callbacks (`queued` / `running`).
	 */
	withRateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal, cb?: RateLimitCallbacks): Promise<T>;
	/** The underlying p-queue (exposed for inspection/testing). */
	readonly queue: PQueue;
}

/**
 * Build a shared rate limiter over a p-queue.
 *
 * `concurrency` bounds in-flight work; `intervalCap`/`interval` bound the start
 * rate. `strict` enables a sliding window (no boundary bursts). This is the one
 * reusable throttle primitive for both OSM clients — see ADR-0005.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
	// Only pass defined optional fields — p-queue's spread treats an explicit
	// `undefined` as overriding its own Infinity defaults, throwing. Declare a
	// mutable shape (PQueue's `Options` marks these readonly).
	const queueOpts: {
		concurrency: number;
		intervalCap?: number;
		interval?: number;
		strict?: boolean;
	} = { concurrency: opts.concurrency };
	if (opts.intervalCap !== undefined) queueOpts.intervalCap = opts.intervalCap;
	if (opts.interval !== undefined) queueOpts.interval = opts.interval;
	if (opts.strict !== undefined) queueOpts.strict = opts.strict;
	const queue = new PQueue(queueOpts);
	const concurrency = opts.concurrency;
	const service = opts.service ?? "osm";
	const logger = opts.logger ?? silentLogger;

	return {
		queue,
		withRateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal, cb: RateLimitCallbacks = {}) {
			// Emit "queued" only when this task is guaranteed to wait: all
			// concurrency slots are occupied at enqueue time. JS is
			// single-threaded so this check is race-free.
			//
			// Accepted divergence (ADR-0005): a task that must wait purely on
			// an interval slot (concurrency free, but rate-limited) does not
			// emit "queued". This only affects the single-user interval-only
			// case; the multi-tenant contention case (ADR-0004 invariant)
			// always has a slot occupied and emits correctly.
			if (queue.pending >= concurrency) cb.onProgress?.({ type: "queued" });
			if (queue.size > 0) {
				logger.debug(
					{ service, queueSize: queue.size, pending: queue.pending },
					"queue backpressure",
				);
			}

			const enqueuedAt = Date.now();
			return queue
				.add(
					async () => {
						logger.debug(
							{
								service,
								waitMs: Date.now() - enqueuedAt,
								queueSize: queue.size,
								pending: queue.pending,
							},
							"rate-limit slot acquired",
						);
						cb.onProgress?.({ type: "running" });
						return fn();
					},
					{ signal },
				)
				.catch((err: unknown) => {
					// CAVEAT #1 / #3: normalize aborts to the historical shape;
					// let every other rejection (OsmServerBusyError, osmFetch
					// errors, etc.) pass through untouched.
					if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
					throw err;
				}) as Promise<T>;
		},
	};
}
