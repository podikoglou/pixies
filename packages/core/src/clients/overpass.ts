import { Result, TaggedError } from "better-result";
import PQueue from "p-queue";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { silentLogger, type Logger } from "../logging/index.ts";
import { ToolAbortedError } from "../errors.ts";
import { isAbortError, mergeSignals } from "../utils/abort.ts";
import type { ToolProgress } from "../tools/progress.ts";

/** Overpass returned a busy / non-retryable condition; see {@link isOverpassBusyResponse} for the status/marker set. */
export class OverpassBusyError extends TaggedError("OverpassBusy")<{
	status: number;
	message: string;
}>() {
	constructor(args: { status: number }) {
		super({ ...args, message: `Overpass: OSM server busy (HTTP ${args.status})` });
	}
}

/** Non-ok Overpass response that is not a busy signal, or a network/timeout failure. */
export class OverpassHttpError extends TaggedError("OverpassHttp")<{
	status?: number;
	body?: string;
	message: string;
	cause?: unknown;
}>() {}

/** Overpass response body did not match the expected TypeBox schema. */
export class OverpassParseError extends TaggedError("OverpassParse")<{
	message: string;
	cause?: unknown;
}>() {}

/** Overpass returned a `remark` field (runtime error string). */
export class OverpassRemarkError extends TaggedError("OverpassRemark")<{
	remark: string;
	message: string;
}>() {
	constructor(args: { remark: string }) {
		super({ ...args, message: `Overpass: ${args.remark}` });
	}
}

/** Union of all errors an Overpass client method can return. */
export type OverpassError =
	| OverpassBusyError
	| OverpassHttpError
	| OverpassParseError
	| OverpassRemarkError
	| ToolAbortedError;

/** Progress callbacks emitted around Overpass queue waits and execution. */
export interface OverpassRateLimitCallbacks {
	onProgress?: (progress: ToolProgress) => void;
}

/** TypeBox schema for a single Overpass element. */
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

/** Parsed Overpass element. */
export type OverpassElement = Static<typeof OverpassElementSchema>;

/** TypeBox schema for an Overpass JSON response. */
export const OverpassResponseSchema = Type.Object({
	version: Type.Optional(Type.Number()),
	generator: Type.Optional(Type.String()),
	elements: Type.Optional(Type.Array(OverpassElementSchema)),
	remark: Type.Optional(Type.String()),
});

/** Parsed Overpass JSON response. */
export type OverpassResponse = Static<typeof OverpassResponseSchema>;

/**
 * TypeBox schema for {@link OverpassClient} configuration. Single source of
 * truth for the client's config knobs: type, bounds, defaults, and
 * descriptions live here, next to the client that owns them. The constructor
 * applies defaults and validates bounds via `Value.Default` + `Value.Parse`,
 * so direct construction (tests, adapters, scripts) fails fast at the boundary
 * instead of misbehaving inside `p-queue` on the first request.
 *
 * The defaulted knobs are wrapped in `Type.Optional` so callers may omit them;
 * `Value.Default` fills them at construction time. `fetch` and `logger` are
 * dependency-injection overrides, not config values, so they live on the
 * derived {@link OverpassConfig} type rather than this schema.
 */
export const OverpassConfigSchema = Type.Object({
	baseUrl: Type.String({
		format: "url",
		description: "Overpass interpreter URL (e.g. https://overpass-api.de/api/interpreter).",
	}),
	userAgent: Type.String({ description: "User-Agent header for Overpass requests." }),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 2,
			description:
				"Max concurrent in-flight requests. Defaults to 2 (the default public overpass-api.de per-IP policy, reported by /api/status). Configurable for self-hosted mirrors.",
		}),
	),
	intervalCap: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 2,
			description: "Max requests started per intervalMs window. Defaults to 2.",
		}),
	),
	intervalMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 1000,
			description:
				"Interval window length in ms. Defaults to 1000. Configurable for self-hosted mirrors and tests.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			default: 60_000,
			description:
				"Timeout for each Overpass HTTP request in ms. Defaults to 60_000 to preserve prior behavior; Overpass legitimately takes 10–60s on a healthy instance, so a too-tight value kills healthy slow queries. Configurable (PIXIES_OVERPASS_TIMEOUT_MS) so the default can be revised from per-query latency measurement once the boundary between healthy-slow and hung is known.",
		}),
	),
});

/**
 * Runtime configuration for {@link OverpassClient}. The config knobs come from
 * {@link OverpassConfigSchema}; `fetch` and `logger` are appended here as
 * dependency-injection overrides (not validated by the schema).
 */
export type OverpassConfig = Static<typeof OverpassConfigSchema> & {
	/** Injectable fetch; defaults to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
};

/**
 * {@link OverpassConfig} with every defaulted knob filled by `Value.Default`.
 * The schema's `Type.Optional` wrappers only model the *input* (callers may
 * omit knobs); after defaulting they are always present, so the constructor
 * narrows to this shape.
 */
interface ResolvedOverpassConfig {
	baseUrl: string;
	userAgent: string;
	concurrency: number;
	intervalCap: number;
	intervalMs: number;
	timeoutMs: number;
}

/** Body substrings Overpass emits when overloaded (HTTP status is the primary signal). */
const BUSY_BODY_MARKERS = [
	"<status>HTTP 503</status>",
	"The server is probably too busy to handle your request",
	"Probably the server is down",
	"Probably the server is overcrowded",
];

/**
 * Model-facing message returned when Overpass reports a server-busy condition.
 * Names the service so the model can tell the user which one is down rather
 * than collapsing both backing services into a generic "OSM".
 */
export const OVERPASS_BUSY_MESSAGE =
	"Overpass is currently overloaded or unavailable. This is a transient infrastructure issue — " +
	"do not retry this or a different Overpass query. Tell the user that Overpass is temporarily " +
	"unavailable and suggest they try again later.";

/** Client for Overpass QL queries. */
export class OverpassClient {
	private baseUrl: string;
	private userAgent: string;
	private fetchFn: typeof globalThis.fetch;
	private queue: PQueue;
	private concurrency: number;
	private logger: Logger;
	/**
	 * Per-request timeout in ms. Backs the `timeoutMs` passed to
	 * {@link fetchOverpassResponse}; defaults to 60_000 prior-behavior.
	 */
	private timeoutMs: number;

	constructor(config: OverpassConfig) {
		// `Value.Default` fills the documented defaults for omitted knobs; `Value.Parse`
		// then enforces the bounds (and URL format) so a bad direct construction
		// (e.g. concurrency: 0) throws here, not inside p-queue. The Optional wrappers
		// model the *input*; after defaulting the knobs are present, so the result
		// narrows to ResolvedOverpassConfig.
		const cfg = Value.Parse(
			OverpassConfigSchema,
			Value.Default(OverpassConfigSchema, config),
		) as ResolvedOverpassConfig;
		this.baseUrl = cfg.baseUrl;
		this.userAgent = cfg.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.logger = config.logger ?? silentLogger;
		this.concurrency = cfg.concurrency;
		this.timeoutMs = cfg.timeoutMs;
		this.queue = new PQueue({
			concurrency: this.concurrency,
			intervalCap: cfg.intervalCap,
			interval: cfg.intervalMs,
		});
	}

	/** Run an Overpass QL query and parse the JSON response. */
	async query(
		query: string,
		parentSignal?: AbortSignal,
		callbacks: OverpassRateLimitCallbacks = {},
	): Promise<Result<OverpassResponse, OverpassError>> {
		const logger = this.logger;
		return Result.tryPromise({
			try: () =>
				this.withRateLimit(
					async () => {
						logger.debug("request", { service: "Overpass", queryLength: query.length });
						const start = Date.now();
						const res = await fetchOverpassResponse(this.baseUrl, this.fetchFn, {
							method: "POST",
							headers: {
								"User-Agent": this.userAgent,
								"Content-Type": "application/x-www-form-urlencoded",
							},
							body: `data=${encodeURIComponent(query)}`,
							signal: parentSignal,
							timeoutMs: this.timeoutMs,
						});
						logger.debug("response", {
							service: "Overpass",
							statusCode: res.status,
							durationMs: Date.now() - start,
						});
						const contentType = res.headers.get("content-type") ?? "";
						if (!contentType.includes("application/json")) {
							logger.warning("non-json content type", {
								service: "Overpass",
								statusCode: res.status,
								contentType,
							});
							throw new OverpassParseError({ message: "Only [out:json] is supported" });
						}
						const json = await res.json();
						let parsed: OverpassResponse;
						try {
							parsed = Value.Parse(OverpassResponseSchema, json);
						} catch (err) {
							logger.warning("invalid response shape", {
								service: "Overpass",
								statusCode: res.status,
								contentType,
								cause: err,
							});
							throw new OverpassParseError({
								message: "Overpass: invalid response shape",
								cause: err,
							});
						}
						if (parsed.remark) {
							logger.warning("overpass remark", {
								service: "Overpass",
								statusCode: res.status,
								contentType,
								remark: parsed.remark,
							});
							throw new OverpassRemarkError({ remark: parsed.remark });
						}
						return parsed;
					},
					parentSignal,
					callbacks,
				),
			catch: toOverpassError,
		});
	}

	private withRateLimit<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal,
		callbacks: OverpassRateLimitCallbacks = {},
	): Promise<T> {
		if (this.queue.pending >= this.concurrency) callbacks.onProgress?.({ type: "queued" });
		if (this.queue.size > 0) {
			this.logger.debug("queue backpressure", {
				service: "Overpass",
				queueSize: this.queue.size,
				pending: this.queue.pending,
			});
		}

		const enqueuedAt = Date.now();
		return this.queue
			.add(
				async () => {
					this.logger.debug("rate-limit slot acquired", {
						service: "Overpass",
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
}

/** Format an Overpass element as the model-facing pipe-delimited line. */
export function formatElement(el: OverpassElement): string {
	const segments: string[] = [`${el.type}/${el.id}`];

	const coord = getElementCoords(el);
	if (coord) {
		segments.push(formatCoord(coord.lat, coord.lon));
	} else if (el.type !== "node") {
		segments.push("(no center)");
	}

	const name = el.tags?.name;
	if (name) segments.push(name);

	const otherTags = el.tags ? Object.entries(el.tags).filter(([k]) => k !== "name") : [];
	const tail: string[] = [];
	if (otherTags.length > 0) {
		tail.push(otherTags.map(([k, v]) => `${k}=${v}`).join(", "));
	}
	if (el.geometry && el.geometry.length > 0) {
		tail.push(`geom=${el.geometry.length}pts`);
	}
	if (tail.length > 0) segments.push(tail.join(", "));

	return segments.join(" | ");
}

interface FetchOverpassOptions {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

async function fetchOverpassResponse(
	url: string,
	fetchFn: typeof globalThis.fetch,
	opts: FetchOverpassOptions,
): Promise<Response> {
	const { signal, timeoutMs, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	const res = await fetchFn(url, { ...rest, signal: merged });
	if (!res.ok) {
		const body = await res.text();
		if (isOverpassBusyResponse(res.status, body)) {
			throw new OverpassBusyError({ status: res.status });
		}
		throw new OverpassHttpError({
			status: res.status,
			body,
			message: `Overpass: ${res.status}: ${body}`,
		});
	}
	return res;
}

function isOverpassBusyResponse(status: number, body: string): boolean {
	if ([429, 502, 503, 504].includes(status)) return true;
	return BUSY_BODY_MARKERS.some((marker) => body.includes(marker));
}

function toOverpassError(e: unknown): OverpassError {
	if (OverpassBusyError.is(e)) return e;
	if (OverpassHttpError.is(e)) return e;
	if (OverpassParseError.is(e)) return e;
	if (OverpassRemarkError.is(e)) return e;
	if (ToolAbortedError.is(e)) return e;
	if (isAbortError(e)) return new ToolAbortedError({ message: "Operation aborted", cause: e });
	return new OverpassHttpError({
		message: `network error: ${e instanceof Error ? e.message : String(e)}`,
		cause: e,
	});
}

function formatCoord(lat: number, lon: number): string {
	return `${lat},${lon}`;
}

/**
 * Resolve the best coordinate for an Overpass element: direct `lat`/`lon`,
 * else the `center` (ways/relations queried with `out center;`), else none.
 */
export function getElementCoords(el: OverpassElement): { lat: number; lon: number } | null {
	if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lon: el.lon };
	if (el.center) return el.center;
	return null;
}
