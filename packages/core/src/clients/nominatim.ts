import { Result, TaggedError } from "better-result";
import PQueue from "p-queue";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { LRUCache } from "lru-cache";
import { silentLogger, type Logger } from "../logging/index.ts";
import { ToolAbortedError } from "../errors.ts";
import { isAbortError, mergeSignals } from "../utils/abort.ts";
import type { ToolProgress } from "../tools/progress.ts";

/** Nominatim returned a busy / non-retryable condition; see {@link isNominatimBusyResponse} for the status/marker set. */
export class NominatimBusyError extends TaggedError("NominatimBusy")<{
	status: number;
	message: string;
}>() {
	constructor(args: { status: number }) {
		super({ ...args, message: `Nominatim: OSM server busy (HTTP ${args.status})` });
	}
}

/** Non-ok Nominatim response that is not a busy signal, or a network/timeout failure. */
export class NominatimHttpError extends TaggedError("NominatimHttp")<{
	status?: number;
	body?: string;
	message: string;
	cause?: unknown;
}>() {}

/** Nominatim response body did not match the expected TypeBox schema. */
export class NominatimParseError extends TaggedError("NominatimParse")<{
	message: string;
	cause?: unknown;
}>() {}

/** Union of all errors a Nominatim client method can return. */
export type NominatimError =
	| NominatimBusyError
	| NominatimHttpError
	| NominatimParseError
	| ToolAbortedError;

/** Progress callbacks emitted around Nominatim queue waits and execution. */
export interface NominatimRateLimitCallbacks {
	onProgress?: (progress: ToolProgress) => void;
}

/** TypeBox schema for a single Nominatim result. */
export const NominatimResultSchema = Type.Object({
	place_id: Type.Number(),
	lat: Type.String(),
	lon: Type.String(),
	display_name: Type.String(),
	name: Type.Optional(Type.String()),
	type: Type.Optional(Type.String()),
	class: Type.Optional(Type.String()),
	addresstype: Type.Optional(Type.String()),
	osm_type: Type.Optional(
		Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	),
	osm_id: Type.Optional(Type.Number()),
	boundingbox: Type.Optional(
		Type.Tuple([Type.String(), Type.String(), Type.String(), Type.String()]),
	),
});

/** Parsed Nominatim result. */
export type NominatimResult = Static<typeof NominatimResultSchema>;

/** TypeBox schema for a Nominatim search response. */
export const NominatimSearchResponseSchema = Type.Array(NominatimResultSchema);

/** Options for Nominatim search calls. */
export interface SearchOptions {
	limit?: number;
}

/** Options for Nominatim reverse-geocode calls. */
export interface ReverseOptions {
	zoom?: number;
}

/**
 * TypeBox schema for {@link NominatimClient} configuration. Single source of
 * truth for the client's config knobs: type, bounds, defaults, and
 * descriptions live here, next to the client that owns them. The constructor
 * applies defaults and validates bounds via `Value.Default` + `Value.Parse`,
 * so direct construction (tests, adapters, scripts) fails fast at the boundary
 * instead of misbehaving inside `p-queue` / `LRUCache` on the first request.
 *
 * The defaulted knobs are wrapped in `Type.Optional` so callers may omit them;
 * `Value.Default` fills them at construction time. `fetch` and `logger` are
 * dependency-injection overrides, not config values, so they live on the
 * derived {@link NominatimConfig} type rather than this schema.
 */
export const NominatimConfigSchema = Type.Object({
	baseUrl: Type.String({
		format: "url",
		description: "Nominatim base URL (e.g. https://nominatim.openstreetmap.org).",
	}),
	contactEmail: Type.Optional(
		Type.String({
			format: "email",
			description: "Contact email appended to requests for the OSM usage policy.",
		}),
	),
	userAgent: Type.String({ description: "User-Agent header for Nominatim requests." }),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 1,
			description:
				"Max concurrent in-flight requests. Defaults to 1 (the default public nominatim.openstreetmap.org per-IP policy). Configurable for self-hosted mirrors.",
		}),
	),
	intervalCap: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 1,
			description: "Max requests started per intervalMs window. Defaults to 1.",
		}),
	),
	intervalMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 1100,
			description:
				"Interval window length in ms. Defaults to 1100 to stay safely under the default public Nominatim's 1 req/s per-IP policy. Configurable for self-hosted mirrors and fast tests.",
		}),
	),
	cacheTtlMs: Type.Optional(
		Type.Integer({
			minimum: 0,
			default: 0,
			description:
				"TTL for cached search/reverse responses, in ms. When > 0 (and cacheMaxEntries > 0) successful parsed responses are cached so repeat queries skip the network and the rate-limit queue entirely. Defaults to 0 (disabled at the client layer); the config schema (PIXIES_NOMINATIM_CACHE_TTL_MS, default 24h) enables it in production.",
		}),
	),
	cacheMaxEntries: Type.Optional(
		Type.Integer({
			minimum: 0,
			default: 0,
			description:
				"Max cached responses before LRU eviction. Must be > 0 (alongside cacheTtlMs) to enable caching. Defaults to 0 (disabled).",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 60_000,
			description:
				"Timeout for each Nominatim HTTP request in ms. Defaults to 60_000 to preserve prior behavior; Nominatim is fast and 1 req/s-capped, so this is a latency-budget hole when it hangs — configurable (PIXIES_NOMINATIM_TIMEOUT_MS) so the default can be tightened from per-query latency measurement.",
		}),
	),
});

/**
 * Runtime configuration for {@link NominatimClient}. The config knobs come from
 * {@link NominatimConfigSchema}; `fetch` and `logger` are appended here as
 * dependency-injection overrides (not validated by the schema).
 */
export type NominatimConfig = Static<typeof NominatimConfigSchema> & {
	/** Injectable fetch; defaults to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
};

/**
 * {@link NominatimConfig} with every defaulted knob filled by `Value.Default`.
 * The schema's `Type.Optional` wrappers only model the *input* (callers may
 * omit knobs); after defaulting they are always present, so the constructor
 * narrows to this shape.
 */
interface ResolvedNominatimConfig {
	baseUrl: string;
	contactEmail?: string;
	userAgent: string;
	concurrency: number;
	intervalCap: number;
	intervalMs: number;
	cacheTtlMs: number;
	cacheMaxEntries: number;
	timeoutMs: number;
}

/** Body substrings Nominatim emits when overloaded (HTTP status is the primary signal). */
const BUSY_BODY_MARKERS = ["The server is probably too busy to handle your request"];

/**
 * Model-facing message returned when Nominatim reports a server-busy
 * condition. Names the service so the model can tell the user which one is
 * down rather than collapsing both backing services into a generic "OSM".
 */
export const NOMINATIM_BUSY_MESSAGE =
	"Nominatim is currently overloaded or unavailable. This is a transient infrastructure issue — " +
	"do not retry this or a different Nominatim query. Tell the user that Nominatim is temporarily " +
	"unavailable and suggest they try again later.";

/** Client for Nominatim search and reverse-geocoding. */
export class NominatimClient {
	private baseUrl: string;
	private contactEmail?: string;
	private userAgent: string;
	private fetchFn: typeof globalThis.fetch;
	private logger: Logger;
	private queue: PQueue;
	private concurrency: number;
	/**
	 * Per-request timeout in ms. Backs the `timeoutMs` passed to
	 * {@link fetchNominatimResponse}; defaults to 60_000 prior-behavior.
	 */
	private timeoutMs: number;
	/**
	 * LRU+TTL cache for successful search/reverse responses. `undefined` when
	 * caching is disabled (either knob is 0).
	 *
	 * The cache lives on the single shared client, so by ADR-0004 it is
	 * process-global — one client ⇒ one cache ⇒ every conversation shares
	 * the hit rate. Cache hits are checked **before** `fetchJson`, so a hit
	 * never enters the rate-limit queue and never consumes a 1 req/s slot;
	 * do not move the lookup inside `fetchJson`.
	 *
	 * Only successful parsed results are stored; errors (`NominatimBusyError`,
	 * invalid-shape, network) propagate uncached so a transient failure is
	 * retried on the next call rather than served stale.
	 */
	private cache?: LRUCache<string, NominatimResult[] | NominatimResult>;

	constructor(config: NominatimConfig) {
		// `Value.Default` fills the documented defaults for omitted knobs; `Value.Parse`
		// then enforces the bounds (and URL/email formats) so a bad direct construction
		// (e.g. concurrency: -5, intervalMs: 0) throws here, not inside p-queue / LRUCache.
		// The Optional wrappers model the *input*; after defaulting the knobs are present,
		// so the result narrows to ResolvedNominatimConfig.
		const cfg = Value.Parse(
			NominatimConfigSchema,
			Value.Default(NominatimConfigSchema, config),
		) as ResolvedNominatimConfig;
		this.baseUrl = cfg.baseUrl;
		this.contactEmail = cfg.contactEmail;
		this.userAgent = cfg.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.logger = config.logger ?? silentLogger;
		this.concurrency = cfg.concurrency;
		this.timeoutMs = cfg.timeoutMs;
		this.queue = new PQueue({
			concurrency: this.concurrency,
			intervalCap: cfg.intervalCap,
			interval: cfg.intervalMs,
			strict: true,
		});

		if (cfg.cacheTtlMs > 0 && cfg.cacheMaxEntries > 0) {
			this.cache = new LRUCache({ max: cfg.cacheMaxEntries, ttl: cfg.cacheTtlMs });
		}
	}

	private buildUrl(path: string, params: Record<string, string | number | undefined>): URL {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		if (this.contactEmail) url.searchParams.set("email", this.contactEmail);
		return url;
	}

	private withRateLimit<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal,
		callbacks: NominatimRateLimitCallbacks = {},
	): Promise<T> {
		if (this.queue.pending >= this.concurrency) callbacks.onProgress?.({ type: "queued" });
		if (this.queue.size > 0) {
			this.logger.debug("queue backpressure", {
				service: "Nominatim",
				queueSize: this.queue.size,
				pending: this.queue.pending,
			});
		}

		const enqueuedAt = Date.now();
		return this.queue
			.add(
				async () => {
					this.logger.debug("rate-limit slot acquired", {
						service: "Nominatim",
						waitMs: Date.now() - enqueuedAt,
						queueSize: this.queue.size,
						pending: this.queue.pending,
					});
					callbacks.onProgress?.({ type: "running" });
					return fn();
				},
				{ signal },
			)
			.catch((err: unknown) => {
				if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
				throw err;
			}) as Promise<T>;
	}

	private async fetchJson(
		url: URL,
		signal?: AbortSignal,
		callbacks: NominatimRateLimitCallbacks = {},
	): Promise<{ json: unknown; statusCode: number; contentType: string }> {
		return this.withRateLimit(
			async () => {
				this.logger.debug("request", { service: "Nominatim", url: url.toString() });
				const start = Date.now();
				const res = await fetchNominatimResponse(url, this.fetchFn, {
					headers: { "User-Agent": this.userAgent },
					signal,
					timeoutMs: this.timeoutMs,
				});
				this.logger.debug("response", {
					service: "Nominatim",
					statusCode: res.status,
					durationMs: Date.now() - start,
				});
				const contentType = res.headers.get("content-type") ?? "";
				const json = await res.json();
				return { json, statusCode: res.status, contentType };
			},
			signal,
			callbacks,
		);
	}

	/** Search Nominatim for a place name or address. */
	async search(
		query: string,
		opts: SearchOptions = {},
		signal?: AbortSignal,
		callbacks: NominatimRateLimitCallbacks = {},
	): Promise<Result<NominatimResult[], NominatimError>> {
		const key = `search:${query.trim().toLowerCase()}:${opts.limit ?? ""}`;
		const cached = this.cache?.get(key);
		if (cached !== undefined) {
			this.logger.debug("cache hit", { service: "Nominatim", event: "cache_hit" });
			return Result.ok(cached as NominatimResult[]);
		}
		const url = this.buildUrl("/search", {
			q: query,
			format: "jsonv2",
			limit: opts.limit,
			addressdetails: 1,
		});
		const cache = this.cache;
		const logger = this.logger;
		const fetchResult = await Result.tryPromise({
			try: () => this.fetchJson(url, signal, callbacks),
			catch: toNominatimError,
		});
		if (Result.isError(fetchResult)) return Result.err(fetchResult.error);
		const { json, statusCode, contentType } = fetchResult.value;
		return Result.try({
			try: () => {
				const parsed = Value.Parse(NominatimSearchResponseSchema, json);
				cache?.set(key, parsed);
				return parsed;
			},
			catch: (err) => {
				logger.warning("invalid search response shape", {
					service: "Nominatim",
					statusCode,
					contentType,
					cause: err,
				});
				return new NominatimParseError({
					message: "Nominatim: invalid search response shape",
					cause: err,
				});
			},
		});
	}

	/** Reverse-geocode coordinates through Nominatim. */
	async reverse(
		lat: number,
		lon: number,
		opts: ReverseOptions = {},
		signal?: AbortSignal,
		callbacks: NominatimRateLimitCallbacks = {},
	): Promise<Result<NominatimResult | null, NominatimError>> {
		const key = `reverse:${lat.toFixed(5)}:${lon.toFixed(5)}:${opts.zoom ?? ""}`;
		const cached = this.cache?.get(key);
		if (cached !== undefined) {
			this.logger.debug("cache hit", { service: "Nominatim", event: "cache_hit" });
			return Result.ok(cached as NominatimResult);
		}
		const url = this.buildUrl("/reverse", {
			lat,
			lon,
			format: "jsonv2",
			zoom: opts.zoom,
			addressdetails: 1,
		});
		const cache = this.cache;
		const logger = this.logger;
		const fetchResult = await Result.tryPromise({
			try: () => this.fetchJson(url, signal, callbacks),
			catch: toNominatimError,
		});
		if (Result.isError(fetchResult)) return Result.err(fetchResult.error);
		const { json, statusCode, contentType } = fetchResult.value;
		return Result.try({
			try: () => {
				if (typeof json !== "object" || json === null) {
					logger.warning("invalid reverse response", {
						service: "Nominatim",
						statusCode,
						contentType,
					});
					throw new NominatimParseError({ message: "Nominatim: invalid reverse response" });
				}
				const result = json as NominatimResult | { error?: string };
				if ("error" in result && result.error) {
					logger.warning("reverse error response", {
						service: "Nominatim",
						statusCode,
						contentType,
					});
					throw new NominatimParseError({ message: `Nominatim: ${result.error}` });
				}
				try {
					const parsed = Value.Parse(NominatimResultSchema, result);
					cache?.set(key, parsed);
					return parsed;
				} catch (err) {
					logger.warning("invalid reverse response shape", {
						service: "Nominatim",
						statusCode,
						contentType,
						cause: err,
					});
					throw new NominatimParseError({
						message: "Nominatim: invalid reverse response shape",
						cause: err,
					});
				}
			},
			catch: (err): NominatimError =>
				err instanceof NominatimParseError
					? err
					: new NominatimParseError({ message: String(err), cause: err }),
		});
	}
}

/** Format a Nominatim result as the model-facing pipe-delimited line. */
export function formatNominatimResult(r: NominatimResult): string {
	const segments: string[] = [];

	if (r.osm_type && r.osm_id !== undefined) {
		segments.push(`${r.osm_type}/${r.osm_id}`);
	} else {
		segments.push(`place/${r.place_id}`);
	}

	segments.push(`${r.lat},${r.lon}`);

	if (r.display_name) segments.push(r.display_name);

	const category = r.class && r.type ? `${r.class}/${r.type}` : (r.class ?? r.type);
	if (category) segments.push(category);

	return segments.join(" | ");
}

interface FetchNominatimOptions {
	headers: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs: number;
}

async function fetchNominatimResponse(
	url: URL,
	fetchFn: typeof globalThis.fetch,
	opts: FetchNominatimOptions,
): Promise<Response> {
	const { signal, timeoutMs, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	try {
		const res = await fetchFn(url, { ...rest, signal: merged });
		if (!res.ok) {
			const body = await res.text();
			if (isNominatimBusyResponse(res.status, body)) {
				throw new NominatimBusyError({ status: res.status });
			}
			throw new NominatimHttpError({
				status: res.status,
				body,
				message: `Nominatim: ${res.status}: ${body}`,
			});
		}
		return res;
	} catch (e) {
		if (e instanceof NominatimBusyError || e instanceof NominatimHttpError) throw e;
		if (isAbortError(e)) throw e;
		throw new NominatimHttpError({
			message: `network error: ${e instanceof Error ? e.message : String(e)}`,
			cause: e,
		});
	}
}

function isNominatimBusyResponse(status: number, body: string): boolean {
	if ([429, 502, 503, 504].includes(status)) return true;
	return BUSY_BODY_MARKERS.some((marker) => body.includes(marker));
}

function toNominatimError(e: unknown): NominatimError {
	if (e instanceof NominatimBusyError) return e;
	if (e instanceof NominatimHttpError) return e;
	if (e instanceof NominatimParseError) return e;
	if (e instanceof ToolAbortedError) return e;
	if (isAbortError(e)) return new ToolAbortedError({ message: "Operation aborted", cause: e });
	return new NominatimHttpError({ message: String(e), cause: e });
}
