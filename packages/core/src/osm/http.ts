import { Result } from "better-result";
import {
	OsmBusyError,
	OsmHttpError,
	OsmParseError,
	OsmRemarkError,
	ToolAbortedError,
	type OsmError,
} from "../errors.ts";

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
 * Result-returning (issue #109): the response is delivered as
 * `Result<Response, OsmBusyError | OsmHttpError>` so callers classify failures
 * by `_tag` instead of `instanceof`/string-matching.
 *
 * - Busy signals (429, 503, or body markers) → `Err(OsmBusyError)` (terminal
 *   from the model's perspective; tool handlers convert this into a
 *   non-retryable result).
 * - Any other non-ok response → `Err(OsmHttpError)` carrying status/body.
 * - A rejected fetch (network/timeout/abort) → `Err(OsmHttpError)` wrapping the
 *   cause, so the caller's `catch` (see {@link toOsmError}) can still classify
 *   aborts as {@link ToolAbortedError}.
 *
 * On ok response, returns the Response with body **unconsumed** so callers
 * can call `.json()` etc.
 */
export async function osmFetch(
	url: string | URL,
	fetchFn: typeof globalThis.fetch,
	opts: OsmFetchOptions = {},
): Promise<Result<Response, OsmBusyError | OsmHttpError>> {
	const { signal, timeoutMs = 60_000, service, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	return Result.tryPromise({
		try: async () => {
			const res = await fetchFn(url, { ...rest, signal: merged });
			if (!res.ok) {
				const prefix = service ? `${service}: ` : "";
				const body = await res.text();
				if (isServerBusyResponse(res.status, body)) {
					throw new OsmBusyError({ status: res.status, service });
				}
				throw new OsmHttpError({
					status: res.status,
					body,
					service,
					message: `${prefix}${res.status}: ${body}`,
				});
			}
			return res;
		},
		catch: (e): OsmBusyError | OsmHttpError =>
			e instanceof OsmBusyError || e instanceof OsmHttpError
				? e
				: new OsmHttpError({
						service,
						message: `network error: ${e instanceof Error ? e.message : String(e)}`,
						cause: e,
					}),
	});
}

/**
 * Normalize any thrown value into an {@link OsmError} for the outer
 * `Result.tryPromise({ catch })` of an OSM client method. Tagged OSM errors
 * pass through unchanged; aborts become {@link ToolAbortedError}; anything else
 * is wrapped in {@link OsmHttpError} so the caller always gets a typed error.
 */
export function toOsmError(e: unknown): OsmError {
	if (e instanceof OsmBusyError) return e;
	if (e instanceof OsmHttpError) return e;
	if (e instanceof OsmParseError) return e;
	if (e instanceof OsmRemarkError) return e;
	if (e instanceof ToolAbortedError) return e;
	if (isAbortError(e)) return new ToolAbortedError({ message: "Operation aborted", cause: e });
	return new OsmHttpError({ message: String(e), cause: e });
}

/** True for both native `AbortError` and `DOMException` aborts (cross-runtime). */
export function isAbortError(err: unknown): boolean {
	if (err instanceof Error && err.name === "AbortError") return true;
	return (
		typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"
	);
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
