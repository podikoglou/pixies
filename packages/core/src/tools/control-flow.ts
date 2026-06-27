import { Result } from "better-result";
import { ToolAbortedError } from "../errors.ts";
import type { ToolProgress } from "./progress.ts";

/**
 * Throw {@link ToolAbortedError} when `signal` is already aborted. The
 * entry-point fast path for tools; a signal aborted mid-call surfaces as
 * `ToolAbortedError` through the client's own error union and is re-thrown
 * downstream.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ToolAbortedError({ message: "Operation aborted" });
}

/**
 * Build the progress-forwarding callback every rate-limited client expects,
 * wrapping the tool's `onUpdate` so progress signals travel as partial results
 * with empty content. Returns a no-op-safe callback even when `onUpdate` is
 * absent.
 *
 * @example
 *   nominatim.search(query, opts, signal, { onProgress: forwardProgress(onUpdate) });
 */
export function forwardProgress(
	onUpdate?: (update: { content: never[]; details: ToolProgress }) => void,
): (progress: ToolProgress) => void {
	return (progress) => onUpdate?.({ content: [], details: progress });
}

/**
 * Resolve a client `Result` into its success value, converting one specific
 * tagged "busy" error into a fallback success value and re-throwing every
 * other error.
 *
 * Centralises the data-source tools' busy-handling terminal. The re-throw uses
 * the original error, not `Result.unwrap`: `unwrap` throws a `Panic` that wraps
 * the error, which would break `instanceof` checks (tests assert
 * `rejects.toBeInstanceOf(OverpassHttpError)`) and the framework's
 * `isError: true` marking.
 *
 * @example
 *   return recoverBusyOrThrow(result, "NominatimBusy", {
 *     ...textResult(NOMINATIM_BUSY_MESSAGE),
 *     details: { busy: true, data: [] },
 *   });
 */
export function recoverBusyOrThrow<E extends { _tag: string }, TValue, TBusy>(
	result: Result<TValue, E>,
	busyTag: string,
	busyResult: TBusy,
): TValue | TBusy {
	if (Result.isOk(result)) return result.value;
	if (result.error._tag === busyTag) return busyResult;
	throw result.error;
}
