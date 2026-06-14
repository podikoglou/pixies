export interface OsmFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function osmFetch(
	url: string | URL,
	fetchFn: typeof globalThis.fetch,
	opts: OsmFetchOptions = {},
): Promise<Response> {
	const { signal, timeoutMs = 60_000, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	const res = await fetchFn(url, { ...rest, signal: merged });
	if (!res.ok) {
		throw new Error(`${res.status}: ${await res.text()}`);
	}
	return res;
}

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
