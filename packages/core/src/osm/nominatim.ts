import { osmFetch } from "./http.ts";
import { createRateLimiter, type RateLimitCallbacks } from "./rate-limiter.ts";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

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
	 * Minimum spacing between Nominatim requests (ms). Defaults to 1100 to stay
	 * safely under Nominatim's 1 req/s per-IP policy. Configurable for
	 * self-hosted mirrors and fast tests.
	 */
	rateLimitMs?: number;
}

export class NominatimClient {
	private readonly baseUrl: string;
	private readonly contactEmail?: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	/**
	 * Shared p-queue limiter enforcing Nominatim's per-IP policy:
	 * concurrency 1, at most 1 request per `rateLimitMs` (strict sliding
	 * window → no boundary bursts). One client owns one queue, so the chain
	 * is global to whoever shares this client (ADR-0004 / ADR-0005).
	 */
	private readonly limiter: ReturnType<typeof createRateLimiter>;

	constructor(config: NominatimConfig) {
		this.baseUrl = config.baseUrl;
		this.contactEmail = config.contactEmail;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		// Promote the old module constant (RATE_LIMIT_MS = 1100) to a
		// per-instance config knob — useful for self-hosted mirrors and tests.
		this.limiter = createRateLimiter({
			concurrency: 1,
			intervalCap: 1,
			interval: config.rateLimitMs ?? 1100,
			strict: true,
		});
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
	): Promise<unknown> {
		return this.limiter.withRateLimit(
			async () => {
				const res = await osmFetch(url, this.fetchFn, {
					service: "Nominatim",
					headers: { "User-Agent": this.userAgent },
					signal,
				});
				return res.json();
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
		const url = this.buildUrl("/search", {
			q: query,
			format: "jsonv2",
			limit: opts.limit,
			addressdetails: 1,
		});
		const json = await this.fetchJson(url, signal, callbacks);
		if (!Array.isArray(json) || !json.every((item) => Value.Check(NominatimResultSchema, item))) {
			throw new Error("Nominatim: invalid search response shape");
		}
		return json as NominatimResult[];
	}

	async reverse(
		lat: number,
		lon: number,
		opts: ReverseOptions = {},
		signal?: AbortSignal,
		callbacks: RateLimitCallbacks = {},
	): Promise<NominatimResult | null> {
		const url = this.buildUrl("/reverse", {
			lat,
			lon,
			format: "jsonv2",
			zoom: opts.zoom,
			addressdetails: 1,
		});
		const json = await this.fetchJson(url, signal, callbacks);
		if (typeof json !== "object" || json === null) {
			throw new Error("Nominatim: invalid reverse response");
		}
		const result = json as NominatimResult | { error?: string };
		if ("error" in result && result.error) {
			throw new Error(`Nominatim: ${result.error}`);
		}
		if (!Value.Check(NominatimResultSchema, result)) {
			throw new Error("Nominatim: invalid reverse response shape");
		}
		return result;
	}
}
