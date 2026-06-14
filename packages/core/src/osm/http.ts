export interface OsmFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	service?: string;
}

export async function osmFetch(
	url: string | URL,
	fetchFn: typeof globalThis.fetch,
	opts: OsmFetchOptions = {},
): Promise<Response> {
	const { signal, timeoutMs = 60_000, service, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	const res = await fetchFn(url, { ...rest, signal: merged });
	if (!res.ok) {
		const prefix = service ? `${service}: ` : "";
		throw new Error(`${prefix}${res.status}: ${await res.text()}`);
	}
	return res;
}

export function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	const cleanup = () => controller.abort();
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			cleanup();
			break;
		}
		signal.addEventListener("abort", cleanup, { once: true });
	}
	return controller.signal;
}
