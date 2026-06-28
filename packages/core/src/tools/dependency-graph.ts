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
	/** The error tag the upstream surfaced, if any (for {@link UpstreamFailedError}). */
	upstreamErrorTag?: string;
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
	register(toolCallId: string): { done: (result: StoredResult | null) => void } {
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
			done: (result) => {
				if (entry.settled) return;
				entry.settled = true;
				if (result === null) entry.upstreamErrorTag = "UpstreamFailed";
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
					upstreamErrorTag: entry.upstreamErrorTag,
					message: `Tool call ${dependentId} depends on ${refId}, which failed or was aborted.`,
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
 * resolves; rejects with the signal's reason (wrapped as a
 * {@link TaggedError}-friendly `Error`) when the signal aborts first.
 *
 * Used by {@link TurnCoordinator.awaitResult} so an aborted turn wakes every
 * dependent tool — the framework aborts the agent-level signal, which flows
 * into each tool's `execute`, which would otherwise hang on a coordinator
 * promise that never settles because the upstream was also aborted mid-flight.
 */
async function raceWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	dependentId: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new Error(`Tool call ${dependentId} aborted while awaiting upstream.`);
	// `Promise.race` is sufficient: the abort listener removes itself on
	// settle, and the upstream promise is owned by the coordinator (no leak).
	return Promise.race<T>([
		promise,
		new Promise<T>((_, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(new Error(`Tool call ${dependentId} aborted while awaiting upstream.`));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}),
	]);
}
