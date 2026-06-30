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
