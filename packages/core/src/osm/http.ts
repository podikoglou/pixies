/**
 * Substrings that indicate an OSM server is too busy to handle the request.
 * Covers both Overpass and Nominatim responses.
 */
export const SERVER_BUSY_BODY_MARKERS = [
	"The server is probably too busy to handle your request",
	"<status>HTTP 503</status>",
];

/** Message returned to the model when OSM reports a server-busy condition. */
export const OSM_SERVER_BUSY_MESSAGE =
	"OSM server is currently overloaded or unavailable. This is a transient infrastructure issue — " +
	"do not retry the same or a different OSM query. Tell the user that OSM is temporarily unavailable " +
	"and suggest they try again later.";

/**
 * Check whether an HTTP response from an OSM endpoint indicates a
 * "server busy" condition that should be treated as terminal /
 * non-retryable from the model's perspective.
 *
 * Returns true when:
 * - HTTP status is 429 (Too Many Requests) or 503 (Service Unavailable), OR
 * - Response body contains known busy-signal markers.
 */
export function isServerBusyResponse(status: number, body: string): boolean {
	if (status === 429 || status === 503) return true;
	return SERVER_BUSY_BODY_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Typed error thrown by {@link osmFetch} when the OSM server signals
 * it is too busy to handle the request. This error is caught at the
 * tool boundary and converted into a normal (non-error) tool result
 * so the model does not retry.
 */
export class OsmServerBusyError extends Error {
	readonly status: number;

	constructor(status: number, service?: string) {
		const prefix = service ? `${service}: ` : "";
		super(`${prefix}OSM server busy (HTTP ${status})`);
		this.name = "OsmServerBusyError";
		this.status = status;
	}
}

export interface OsmFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	service?: string;
}

/**
 * Shared HTTP fetch for OSM services (Overpass, Nominatim).
 *
 * On a non-ok response, reads the body text once and classifies it:
 * - Busy signals (429, 503, or body markers) → throws {@link OsmServerBusyError}
 *   (terminal from the model's perspective; tool handlers catch this and return
 *   a non-retryable result).
 * - Everything else → throws a generic `Error` with `"${service}: ${status}: ${body}"`
 *   message (retryable by the model if appropriate).
 *
 * On ok response, returns the Response with body **unconsumed** so callers
 * can call `.json()` etc.
 */
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
		const body = await res.text();
		if (isServerBusyResponse(res.status, body)) {
			throw new OsmServerBusyError(res.status, service);
		}
		throw new Error(`${prefix}${res.status}: ${body}`);
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
