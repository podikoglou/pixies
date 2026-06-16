import { osmFetch, OsmServerBusyError } from "./http.ts";
import { createRateLimiter, type RateLimitCallbacks } from "./rate-limiter.ts";
import { silentLogger, type Logger } from "../logging/index.ts";
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
	/**
	 * Max concurrent in-flight requests. Defaults to 2 (the default public
	 * `overpass-api.de` per-IP policy, reported by `/api/status`). Configurable
	 * for self-hosted mirrors.
	 */
	concurrency?: number;
	/**
	 * Max requests started per {@link intervalMs} window. Defaults to 2.
	 */
	intervalCap?: number;
	/**
	 * Interval window length in ms. Defaults to 1000. Configurable for
	 * self-hosted mirrors and tests.
	 */
	intervalMs?: number;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
}

export class OverpassClient {
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	/**
	 * Shared p-queue limiter. The default public `overpass-api.de` grants
	 * **2 concurrent slots** per IP (`GET /api/status` reports "Rate limit: 2"),
	 * so concurrency is capped at 2; `intervalCap:2`/`interval:1000` bounds
	 * bursts when queries are fast. One client owns one queue (ADR-0004 /
	 * ADR-0005); the per-instance knobs default to the public policy and are
	 * configurable for self-hosted mirrors.
	 */
	private readonly limiter: ReturnType<typeof createRateLimiter>;
	private readonly logger: Logger;

	constructor(config: OverpassConfig) {
		this.baseUrl = config.baseUrl;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.logger = config.logger ?? silentLogger;
		// Build the limiter from the three per-instance knobs (defaults equal
		// the public instance policy: 2/2/1000ms). Overpass stays non-strict.
		this.limiter = createRateLimiter({
			concurrency: config.concurrency ?? 2,
			intervalCap: config.intervalCap ?? 2,
			interval: config.intervalMs ?? 1000,
			service: "Overpass",
			logger: this.logger,
		});
	}

	async query(
		query: string,
		parentSignal?: AbortSignal,
		callbacks?: RateLimitCallbacks,
	): Promise<OverpassResponse> {
		const service = "Overpass";
		return this.limiter.withRateLimit(
			async () => {
				this.logger.debug({ service, queryLength: query.length }, "request");
				const start = Date.now();
				let res: Response;
				try {
					res = await osmFetch(this.baseUrl, this.fetchFn, {
						service,
						method: "POST",
						headers: {
							"User-Agent": this.userAgent,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: `data=${encodeURIComponent(query)}`,
						signal: parentSignal,
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
				if (!contentType.includes("application/json")) {
					this.logger.warn(
						{ service, statusCode: res.status, contentType },
						"non-json content type",
					);
					throw new Error("Only [out:json] is supported");
				}
				const json = await res.json();
				if (!Value.Check(OverpassResponseSchema, json)) {
					this.logger.warn(
						{ service, statusCode: res.status, contentType },
						"invalid response shape",
					);
					throw new Error("Overpass: invalid response shape");
				}
				if (json.remark) {
					this.logger.warn(
						{ service, statusCode: res.status, contentType, remark: json.remark },
						"overpass remark",
					);
					throw new Error(`Overpass: ${json.remark}`);
				}
				return json;
			},
			parentSignal,
			callbacks,
		);
	}
}
