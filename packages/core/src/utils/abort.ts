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

/** Run `fetch` while also rejecting if a provided signal aborts before fetch settles. */
export function fetchWithAbort(
	fetchFn: typeof globalThis.fetch,
	url: string | URL,
	init: RequestInit,
	signal: AbortSignal,
): Promise<Response> {
	if (signal.aborted)
		return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		fetchFn(url, init)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
