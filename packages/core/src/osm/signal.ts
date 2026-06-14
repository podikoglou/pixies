export function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}
