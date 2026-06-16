import { osmFetch } from "./http.ts";
import { createRateLimiter, type RateLimitCallbacks } from "./rate-limiter.ts";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const OverpassElementSchema = Type.Object({
	type: Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
	id: Type.Number(),
	lat: Type.Optional(Type.Number()),
	lon: Type.Optional(Type.Number()),
	center: Type.Optional(
		Type.Object({
			lat: Type.Number(),
			lon: Type.Number(),
		}),
	),
	bounds: Type.Optional(
		Type.Object({
			minlat: Type.Number(),
			minlon: Type.Number(),
			maxlat: Type.Number(),
			maxlon: Type.Number(),
		}),
	),
	nodes: Type.Optional(Type.Array(Type.Number())),
	geometry: Type.Optional(
		Type.Array(
			Type.Object({
				lat: Type.Number(),
				lon: Type.Number(),
			}),
		),
	),
	tags: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type OverpassElement = Static<typeof OverpassElementSchema>;

export const OverpassResponseSchema = Type.Object({
	version: Type.Optional(Type.Number()),
	generator: Type.Optional(Type.String()),
	elements: Type.Optional(Type.Array(OverpassElementSchema)),
	remark: Type.Optional(Type.String()),
});
export type OverpassResponse = Static<typeof OverpassResponseSchema>;

export interface OverpassConfig {
	baseUrl: string;
	userAgent: string;
	fetch?: typeof globalThis.fetch;
}

export class OverpassClient {
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	/**
	 * Shared p-queue limiter. Overpass grants **2 concurrent slots** per IP
	 * (`GET /api/status` reports "Rate limit: 2"), so concurrency is capped at
	 * 2; `intervalCap:2`/`interval:1000` bounds bursts when queries are fast.
	 * One client owns one queue (ADR-0004 / ADR-0005).
	 */
	private readonly limiter = createRateLimiter({
		concurrency: 2,
		intervalCap: 2,
		interval: 1000,
	});

	constructor(config: OverpassConfig) {
		this.baseUrl = config.baseUrl;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
	}

	async query(
		query: string,
		parentSignal?: AbortSignal,
		callbacks?: RateLimitCallbacks,
	): Promise<OverpassResponse> {
		return this.limiter.withRateLimit(
			async () => {
				const res = await osmFetch(this.baseUrl, this.fetchFn, {
					service: "Overpass",
					method: "POST",
					headers: {
						"User-Agent": this.userAgent,
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: `data=${encodeURIComponent(query)}`,
					signal: parentSignal,
				});
				const contentType = res.headers.get("content-type") ?? "";
				if (!contentType.includes("application/json")) {
					throw new Error("Only [out:json] is supported");
				}
				const json = await res.json();
				if (!Value.Check(OverpassResponseSchema, json)) {
					throw new Error("Overpass: invalid response shape");
				}
				if (json.remark) {
					throw new Error(`Overpass: ${json.remark}`);
				}
				return json;
			},
			parentSignal,
			callbacks,
		);
	}
}
