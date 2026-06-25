/** True for both native `AbortError` and `DOMException` aborts (cross-runtime). */
export function isAbortError(err: unknown): boolean {
	if (err instanceof Error && err.name === "AbortError") return true;
	return (
		typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"
	);
}

/** Merge multiple abort signals into a single signal that preserves the first abort reason. */
export function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (!signal) continue;
		const abort = () => controller.abort(signal.reason);
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}
