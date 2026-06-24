import { Result, TaggedError } from "better-result";
import PQueue from "p-queue";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { silentLogger, type Logger } from "../logging/index.ts";
import { ToolAbortedError } from "../errors.ts";
import { fetchWithAbort, isAbortError, mergeSignals } from "../utils/abort.ts";
import type { ToolProgress } from "../tools/progress.ts";
import type { OverpassResultEntry } from "../tools/index.ts";

/** Overpass returned a busy / non-retryable condition (429 / 503 / markers). */
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

/** Runtime configuration for {@link OverpassClient}. */
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
	/** Max requests started per {@link intervalMs} window. Defaults to 2. */
	intervalCap?: number;
	/**
	 * Interval window length in ms. Defaults to 1000. Configurable for
	 * self-hosted mirrors and tests.
	 */
	intervalMs?: number;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
}

const SERVER_BUSY_BODY_MARKERS = [
	"The server is probably too busy to handle your request",
	"<status>HTTP 503</status>",
];

/** Client for Overpass QL queries. */
export class OverpassClient {
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly queue: PQueue;
	private readonly concurrency: number;
	private readonly logger: Logger;

	constructor(config: OverpassConfig) {
		this.baseUrl = config.baseUrl;
		this.userAgent = config.userAgent;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.logger = config.logger ?? silentLogger;
		this.concurrency = config.concurrency ?? 2;
		this.queue = new PQueue({
			concurrency: this.concurrency,
			intervalCap: config.intervalCap ?? 2,
			interval: config.intervalMs ?? 1000,
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
						logger.debug({ service: "Overpass", queryLength: query.length }, "request");
						const start = Date.now();
						const res = await fetchOverpassResponse(this.baseUrl, this.fetchFn, {
							method: "POST",
							headers: {
								"User-Agent": this.userAgent,
								"Content-Type": "application/x-www-form-urlencoded",
							},
							body: `data=${encodeURIComponent(query)}`,
							signal: parentSignal,
						});
						logger.debug(
							{ service: "Overpass", statusCode: res.status, durationMs: Date.now() - start },
							"response",
						);
						const contentType = res.headers.get("content-type") ?? "";
						if (!contentType.includes("application/json")) {
							logger.warn(
								{ service: "Overpass", statusCode: res.status, contentType },
								"non-json content type",
							);
							throw new OverpassParseError({ message: "Only [out:json] is supported" });
						}
						const json = await res.json();
						let parsed: OverpassResponse;
						try {
							parsed = Value.Parse(OverpassResponseSchema, json);
						} catch (err) {
							logger.warn(
								{ service: "Overpass", statusCode: res.status, contentType, cause: err },
								"invalid response shape",
							);
							throw new OverpassParseError({
								message: "Overpass: invalid response shape",
								cause: err,
							});
						}
						if (parsed.remark) {
							logger.warn(
								{ service: "Overpass", statusCode: res.status, contentType, remark: parsed.remark },
								"overpass remark",
							);
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
			this.logger.debug(
				{ service: "Overpass", queueSize: this.queue.size, pending: this.queue.pending },
				"queue backpressure",
			);
		}

		const enqueuedAt = Date.now();
		return this.queue
			.add(
				async () => {
					this.logger.debug(
						{
							service: "Overpass",
							waitMs: Date.now() - enqueuedAt,
							queueSize: this.queue.size,
							pending: this.queue.pending,
						},
						"rate-limit slot acquired",
					);
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

/**
 * Structured, lossless representation of an Overpass element for UI consumers.
 * Content-side counterpart to {@link formatElement}. `name` is hoisted to a
 * top-level field (mirroring {@link formatElement}) and excluded from `tags`
 * so each piece of information appears once in the rendered tree.
 */
export function overpassElementToData(el: OverpassElement): OverpassResultEntry {
	const coord = getElementCoords(el);
	const otherTags = el.tags
		? Object.fromEntries(Object.entries(el.tags).filter(([k]) => k !== "name"))
		: undefined;
	const data: OverpassResultEntry = {
		type: el.type,
		id: el.id,
		...(coord ? { lat: coord.lat, lon: coord.lon } : {}),
		...(el.tags?.name ? { name: el.tags.name } : {}),
		...(otherTags && Object.keys(otherTags).length > 0 ? { tags: otherTags } : {}),
		...(el.geometry && el.geometry.length > 0 ? { geometryPoints: el.geometry.length } : {}),
	};
	return data;
}

interface FetchOverpassOptions {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

async function fetchOverpassResponse(
	url: string,
	fetchFn: typeof globalThis.fetch,
	opts: FetchOverpassOptions,
): Promise<Response> {
	const { signal, timeoutMs = 60_000, ...rest } = opts;
	const merged = mergeSignals(signal, AbortSignal.timeout(timeoutMs));
	try {
		const res = await fetchWithAbort(fetchFn, url, { ...rest, signal: merged }, merged);
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
	} catch (e) {
		if (e instanceof OverpassBusyError || e instanceof OverpassHttpError) throw e;
		if (isAbortError(e)) throw e;
		throw new OverpassHttpError({
			message: `network error: ${e instanceof Error ? e.message : String(e)}`,
			cause: e,
		});
	}
}

function isOverpassBusyResponse(status: number, body: string): boolean {
	if (status === 429 || status === 503) return true;
	return SERVER_BUSY_BODY_MARKERS.some((marker) => body.includes(marker));
}

function toOverpassError(e: unknown): OverpassError {
	if (e instanceof OverpassBusyError) return e;
	if (e instanceof OverpassHttpError) return e;
	if (e instanceof OverpassParseError) return e;
	if (e instanceof OverpassRemarkError) return e;
	if (e instanceof ToolAbortedError) return e;
	if (isAbortError(e)) return new ToolAbortedError({ message: "Operation aborted", cause: e });
	return new OverpassHttpError({ message: String(e), cause: e });
}

function formatCoord(lat: number, lon: number): string {
	return `${lat},${lon}`;
}

function getElementCoords(el: OverpassElement): { lat: number; lon: number } | null {
	if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lon: el.lon };
	if (el.center) return el.center;
	return null;
}
