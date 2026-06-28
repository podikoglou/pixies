import { UnknownRefError, CircularRefError, UpstreamFailedError } from "../errors.ts";
import type { ResultStore, StoredResult } from "./result-store.ts";

/** Errors the coordinator raises to dependent tools. */
export type DependencyError = UnknownRefError | CircularRefError | UpstreamFailedError;

/**
 * Context every ref-aware tool depends on. The coordinator and store are
 * per-conversation (one agent ⇒ one of each); ref-aware tools receive both
 * alongside their other clients (Nominatim, Overpass).
 */
export interface DependencyContext {
	coordinator: TurnCoordinator;
	store: ResultStore;
}

/**
 * Resolve a single ref to its upstream {@link StoredResult}. Cross-turn refs
 * (IDs from previous turns) resolve synchronously from the store; intra-turn
 * refs (IDs in the current batch) await the upstream's completion via the
 * coordinator. Throws {@link UnknownRefError} when the ref matches neither.
 *
 * Public entry point each ref-aware tool calls for every ref field it accepts.
 */
export async function resolveRef(
	ctx: DependencyContext,
	dependentId: string,
	refId: string | undefined,
	signal?: AbortSignal,
): Promise<StoredResult> {
	if (!refId) {
		throw new UnknownRefError({
			toolCallId: dependentId,
			refId: "(missing)",
			message: `Tool call ${dependentId} was invoked without a required ref.`,
		});
	}
	const stored = ctx.store.get(refId);
	if (stored) return stored;
	return ctx.coordinator.awaitResult(refId, dependentId, signal);
}

/** Deferred resolver the registered tool completes when its execute settles. */
interface PendingEntry {
	/** Resolves with the upstream's stored result, or `null` on failure/abort. */
	resolve: (result: StoredResult | null) => void;
	/** The pending promise; dependent tools await this. */
	promise: Promise<StoredResult | null>;
	/** Whether `done()` has been called; defends against double-resolution. */
	settled: boolean;
	/** The cause the upstream surfaced when it failed (for {@link UpstreamFailedError}). */
	upstreamCause?: { tag: string; message: string };
}

/**
 * Reduce any thrown value to a `{ tag, message }` cause. `TaggedError` classes
 * carry their `_tag`; bare errors get the generic `"Error"` tag. Used by
 * {@link TurnCoordinator.register}'s `done(null, error)` so downstream waiters
 * see the real upstream failure mode rather than a placeholder.
 */
function errorToCause(e: unknown): { tag: string; message: string } {
	if (e instanceof Error && "_tag" in e && typeof (e as { _tag: unknown })._tag === "string") {
		return { tag: (e as { _tag: string })._tag, message: e.message };
	}
	return { tag: "Error", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Per-conversation coordinator for dependency-resolved tool execution.
 *
 * The framework (`@earendil-works/pi-agent-core`) dispatches every tool
 * call in a turn itself, in parallel by default — there is no pluggable
 * execution strategy. This coordinator lives one layer up, inside each
 * ref-aware tool's `execute`: the tool registers itself synchronously on
 * entry, then awaits upstream results via {@link awaitResult}. The
 * framework still dispatches in parallel; the dependency order emerges
 * from the `await` chain.
 *
 * The "synchronous prefix of every `execute` runs in source order before
 * any await settles" assumption is load-bearing and was verified against
 * `@earendil-works/pi-agent-core` 0.79.3's `executeToolCallsParallel` (it
 * prepares each tool call sequentially, then `Promise.all`s the wrapped
 * executors). A future framework version that interleaves dispatch
 * differently would silently break intra-turn ref resolution; re-verify
 * the assumption when bumping the framework version. See ADR-0013.
 *
 * The coordinator is per-conversation (one agent ⇒ one coordinator) but
 * the in-flight map is naturally per-turn: tool call IDs are unique across
 * turns, and each entry is removed when its `done` callback fires. A
 * quiesced coordinator has an empty in-flight map.
 */
export class TurnCoordinator {
	private readonly inFlight = new Map<string, PendingEntry>();
	/**
	 * `dependent → set of IDs it is currently awaiting`. Used for lazy cycle
	 * detection at {@link awaitResult} time.
	 */
	private readonly waitingFor = new Map<string, Set<string>>();

	/**
	 * Register `toolCallId` as currently executing in this turn. Returns a
	 * `done` callback the tool MUST invoke when its `execute` settles — on
	 * success with the stored result, on failure/abort with `null`. Calling
	 * `done` resolves every dependent's {@link awaitResult} promise.
	 *
	 * Registration is synchronous so that all sibling tools dispatched in
	 * the same turn appear in the in-flight map before any of their `await`
	 * resumes — JS runs the synchronous prefix of each `execute` in source
	 * order before the first microtask settles.
	 */
	register(toolCallId: string): { done: (result: StoredResult | null, error?: unknown) => void } {
		if (this.inFlight.has(toolCallId)) {
			// Re-registration in the same turn should not happen — IDs are
			// unique per assistant message. Defend against it cheaply by
			// treating it as a programming error rather than silently
			// overwriting the existing pending entry.
			throw new Error(`TurnCoordinator: duplicate registration for ${toolCallId}`);
		}
		let resolve!: (result: StoredResult | null) => void;
		const promise = new Promise<StoredResult | null>((res) => {
			resolve = res;
		});
		const entry: PendingEntry = { resolve, promise, settled: false };
		this.inFlight.set(toolCallId, entry);
		return {
			/**
			 * Settle the registration. Pass the StoredResult on success; on
			 * failure, pass `null` and the thrown value — the coordinator
			 * extracts its `_tag`/message so dependent tools see a typed
			 * {@link UpstreamFailedError} with the real cause rather than a
			 * generic "failed or was aborted".
			 */
			done: (result, error) => {
				if (entry.settled) return;
				entry.settled = true;
				if (result === null && error !== undefined) entry.upstreamCause = errorToCause(error);
				entry.resolve(result);
				// In-flight entry stays until the next microtask so waiters that
				// race-register can still resolve; cleanup is best-effort.
				queueMicrotask(() => {
					if (this.inFlight.get(toolCallId) === entry) this.inFlight.delete(toolCallId);
				});
			},
		};
	}

	/**
	 * Await the upstream result for `refId` on behalf of `dependentId`.
	 * Resolves from the in-flight map when the upstream's `done` callback
	 * fires. Throws {@link UnknownRefError} when `refId` is neither in-flight
	 * nor (caller-checked) in the store; {@link CircularRefError} when the
	 * await would close a cycle; {@link UpstreamFailedError} when the
	 * upstream resolves `null` (it errored or was aborted).
	 *
	 * `signal` is raced against the await so an aborted turn wakes every
	 * waiter rather than hanging on an upstream that will never settle.
	 */
	async awaitResult(
		refId: string,
		dependentId: string,
		signal?: AbortSignal,
	): Promise<StoredResult> {
		if (refId === dependentId) {
			throw new CircularRefError({
				toolCallId: dependentId,
				refId,
				message: `Tool call ${dependentId} references itself.`,
			});
		}
		const entry = this.inFlight.get(refId);
		if (!entry) {
			throw new UnknownRefError({
				toolCallId: dependentId,
				refId,
				message: `Tool call ${dependentId} references unknown tool call ${refId}.`,
			});
		}
		if (this.wouldCycle(dependentId, refId)) {
			throw new CircularRefError({
				toolCallId: dependentId,
				refId,
				message: `Tool call ${dependentId} referencing ${refId} would form a circular dependency.`,
			});
		}
		// Record the wait edge BEFORE awaiting so concurrent sibling waits
		// see a consistent graph for their own cycle checks.
		let waits = this.waitingFor.get(dependentId);
		if (!waits) {
			waits = new Set();
			this.waitingFor.set(dependentId, waits);
		}
		waits.add(refId);
		try {
			const result = await raceWithAbort<StoredResult | null>(entry.promise, signal, dependentId);
			if (result === null) {
				throw new UpstreamFailedError({
					toolCallId: dependentId,
					refId,
					...(entry.upstreamCause
						? {
								upstreamErrorTag: entry.upstreamCause.tag,
								message: `Tool call ${dependentId} depends on ${refId}, which failed: ${entry.upstreamCause.message}`,
							}
						: {
								message: `Tool call ${dependentId} depends on ${refId}, which failed or was aborted.`,
							}),
				});
			}
			return result;
		} finally {
			waits.delete(refId);
			if (waits.size === 0) this.waitingFor.delete(dependentId);
		}
	}

	/** True when `toolCallId` is currently registered in this turn. */
	isInFlight(toolCallId: string): boolean {
		return this.inFlight.has(toolCallId);
	}

	/**
	 * DFS from `waitee` through `waitingFor`; true when the walk reaches
	 * `dependent` (i.e., adding `dependent → waitee` closes a cycle).
	 */
	private wouldCycle(dependent: string, waitee: string): boolean {
		const stack = [waitee];
		const visited = new Set<string>();
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (cur === dependent) return true;
			if (visited.has(cur)) continue;
			visited.add(cur);
			const next = this.waitingFor.get(cur);
			if (next) for (const id of next) stack.push(id);
		}
		return false;
	}
}

/**
 * Race a promise against an abort signal. Resolves with `T` when the promise
 * resolves; rejects when the signal aborts first.
 *
 * The abort listener is removed explicitly in the `finally` — `{ once: true }`
 * alone would NOT remove it on a successful race (the event never fires),
 * leaking one listener per call into the conversation-level signal.
 */
async function raceWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	dependentId: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new Error(`Tool call ${dependentId} aborted while awaiting upstream.`);
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<T>((_, reject) => {
		onAbort = () => reject(new Error(`Tool call ${dependentId} aborted while awaiting upstream.`));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race<T>([promise, abortPromise]);
	} finally {
		// Always remove — covers both the abort-fires path and the success path
		// where the listener would otherwise leak.
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
