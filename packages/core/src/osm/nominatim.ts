import { osmFetch, OsmServerBusyError } from "./http.ts";
import { createRateLimiter, type RateLimitCallbacks } from "./rate-limiter.ts";
import { silentLogger, type Logger } from "../logging/index.ts";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { LRUCache } from "lru-cache";

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
export type NominatimResult = Static<typeof NominatimResultSchema>;
export const NominatimSearchResponseSchema = Type.Array(NominatimResultSchema);

export interface SearchOptions {
	limit?: number;
}

export interface ReverseOptions {
	zoom?: number;
}

export interface NominatimConfig {
	baseUrl: string;
	contactEmail?: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
	/**
	 * Max concurrent in-flight requests. Defaults to 1 (the default public
	 * `nominatim.openstreetmap.org` per-IP policy). Configurable for
	 * self-hosted mirrors.
	 */
	concurrency?: number;
	/**
	 * Max requests started per {@link intervalMs} window. Defaults to 1.
	 */
	intervalCap?: number;
	/**
	 * Interval window length in ms. Defaults to 1100 to stay safely under the
	 * default public Nominatim's 1 req/s per-IP policy. Configurable for
	 * self-hosted mirrors and fast tests.
	 */
	intervalMs?: number;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
	/**
	 * TTL for cached search/reverse responses, in ms. When > 0 (and
	 * {@link cacheMaxEntries} > 0) successful parsed responses are cached so
	 * repeat queries skip the network and the rate-limit queue entirely.
	 * Defaults to 0 (disabled at the client layer); the config schema
	 * (`PIXIES_NOMINATIM_CACHE_TTL_MS`, default 24h) enables it in production.
	 */
	cacheTtlMs?: number;
	/**
	 * Max cached responses before LRU eviction. Must be > 0 (alongside
	 * {@link cacheTtlMs}) to enable caching. Defaults to 0 (disabled).
	 */
	cacheMaxEntries?: number;
}

export class NominatimClient {
	private readonly baseUrl: string;
	private readonly contactEmail?: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly logger: Logger;
	/**
	 * Shared p-queue limiter enforcing Nominatim's per-IP policy:
	 * concurrency 1, at most 1 request per `intervalMs` (strict sliding
	 * window → no boundary bursts). One client owns one queue, so the chain
	 * is global to whoever shares this client (ADR-0004 / ADR-0005). Defaults
	 * match the public `nominatim.openstreetmap.org` policy; `strict:true` is
	 * an internal default (not env-exposed).
	 */
	private readonly limiter: ReturnType<typeof createRateLimiter>;
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
	 * Only successful parsed results are stored; errors (`OsmServerBusyError`,
	 * invalid-shape, network) propagate uncached so a transient failure is
	 * retried on the next call rather than served stale.
	 */
	private readonly cache?: LRUCache<string, NominatimResult[] | NominatimResult>;

	constructor(config: NominatimConfig) {
		this.baseUrl = config.baseUrl;
		this.contactEmail = config.contactEmail;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.logger = config.logger ?? silentLogger;
		// Build the limiter from the three per-instance knobs (defaults equal
		// the public instance policy: 1/1/1100ms). `strict` stays an internal
		// Nominatim default — useful for self-hosted mirrors and tests.
		this.limiter = createRateLimiter({
			concurrency: config.concurrency ?? 1,
			intervalCap: config.intervalCap ?? 1,
			interval: config.intervalMs ?? 1100,
			strict: true,
			service: "Nominatim",
			logger: this.logger,
		});
		// Enable caching only when both knobs are > 0. Client-layer default is
		// off (0); production turns it on via config-schema defaults.
		const ttl = config.cacheTtlMs ?? 0;
		const max = config.cacheMaxEntries ?? 0;
		if (ttl > 0 && max > 0) {
			this.cache = new LRUCache({ max, ttl });
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

	private fetchJson(
		url: URL,
		signal?: AbortSignal,
		opts: RateLimitCallbacks = {},
	): Promise<{ json: unknown; statusCode: number; contentType: string }> {
		const service = "Nominatim";
		return this.limiter.withRateLimit(
			async () => {
				this.logger.debug({ service, url: url.toString() }, "request");
				const start = Date.now();
				let res: Response;
				try {
					res = await osmFetch(url, this.fetchFn, {
						service,
						headers: { "User-Agent": this.userAgent },
						signal,
					});
				} catch (err) {
					if (err instanceof OsmServerBusyError) {
						this.logger.warn(
							{ service, statusCode: err.status, event: "server_busy" },
							"OSM server busy",
						);
					}
					throw err;
				}
				this.logger.debug(
					{ service, statusCode: res.status, durationMs: Date.now() - start },
					"response",
				);
				const contentType = res.headers.get("content-type") ?? "";
				const json = await res.json();
				return { json, statusCode: res.status, contentType };
			},
			signal,
			opts,
		);
	}

	async search(
		query: string,
		opts: SearchOptions = {},
		signal?: AbortSignal,
		callbacks: RateLimitCallbacks = {},
	): Promise<NominatimResult[]> {
		// Cache hit short-circuits before the rate-limit queue — a repeat query
		// never consumes a 1 req/s slot. Query is trimmed + lowercased because
		// Nominatim search is case-insensitive.
		const key = `search:${query.trim().toLowerCase()}:${opts.limit ?? ""}`;
		const cached = this.cache?.get(key);
		if (cached !== undefined) {
			this.logger.debug({ service: "Nominatim", event: "cache_hit" }, "cache hit");
			return cached as NominatimResult[];
		}
		const url = this.buildUrl("/search", {
			q: query,
			format: "jsonv2",
			limit: opts.limit,
			addressdetails: 1,
		});
		const { json, statusCode, contentType } = await this.fetchJson(url, signal, callbacks);
		try {
			const results = Value.Parse(NominatimSearchResponseSchema, json);
			this.cache?.set(key, results);
			return results;
		} catch (err) {
			this.logger.warn(
				{ service: "Nominatim", statusCode, contentType, cause: err },
				"invalid search response shape",
			);
			throw new Error("Nominatim: invalid search response shape", { cause: err });
		}
	}

	async reverse(
		lat: number,
		lon: number,
		opts: ReverseOptions = {},
		signal?: AbortSignal,
		callbacks: RateLimitCallbacks = {},
	): Promise<NominatimResult | null> {
		// Cache hit short-circuits before the rate-limit queue. Coordinates are
		// quantized to 5 decimals (~1.1m): exact-float repeats are rare, but
		// nearby points resolve to the same address.
		const key = `reverse:${lat.toFixed(5)}:${lon.toFixed(5)}:${opts.zoom ?? ""}`;
		const cached = this.cache?.get(key);
		if (cached !== undefined) {
			this.logger.debug({ service: "Nominatim", event: "cache_hit" }, "cache hit");
			return cached as NominatimResult;
		}
		const url = this.buildUrl("/reverse", {
			lat,
			lon,
			format: "jsonv2",
			zoom: opts.zoom,
			addressdetails: 1,
		});
		const { json, statusCode, contentType } = await this.fetchJson(url, signal, callbacks);
		if (typeof json !== "object" || json === null) {
			this.logger.warn(
				{ service: "Nominatim", statusCode, contentType },
				"invalid reverse response",
			);
			throw new Error("Nominatim: invalid reverse response");
		}
		const result = json as NominatimResult | { error?: string };
		if ("error" in result && result.error) {
			this.logger.warn({ service: "Nominatim", statusCode, contentType }, "reverse error response");
			throw new Error(`Nominatim: ${result.error}`);
		}
		try {
			const parsed = Value.Parse(NominatimResultSchema, result);
			this.cache?.set(key, parsed);
			return parsed;
		} catch (err) {
			this.logger.warn(
				{ service: "Nominatim", statusCode, contentType, cause: err },
				"invalid reverse response shape",
			);
			throw new Error("Nominatim: invalid reverse response shape", { cause: err });
		}
	}
}
