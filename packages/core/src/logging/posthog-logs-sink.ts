/**
 * PostHog Logs sink for LogTape — OpenTelemetry (OTLP/HTTP) egress.
 *
 * Forwards `info`+ server log records to **PostHog Logs** over OTLP/HTTP,
 * ingested at `<ph_client_api_host>/i/v1/logs` and authenticated with the
 * PostHog project token via `Authorization: Bearer <token>`.
 *
 * ## Off by default
 * The server only constructs this sink when a PostHog key is configured (see
 * `packages/server/src/index.ts`). Unset → no records leave the instance; the
 * console sink continues to carry full detail.
 *
 * ## Allowlist at egress (privacy by construction)
 * The console sink keeps every field verbatim; **only this egress path
 * filters** `record.properties`. Rather than scrub a denylist of
 * known-sensitive keys, the sink ships ONLY the keys in
 * {@link DEFAULT_ALLOW_KEYS} and replaces every other property with
 * `"[redacted]"` before egress. A future `logger.error(..., { err })` or
 * `{ request }` therefore cannot leak by default — unknown keys are scrubbed
 * unless explicitly approved. Local stdout retains full detail for debugging.
 *
 * Any new server log field that is safe to ship MUST be added to
 * {@link DEFAULT_ALLOW_KEYS} (see docs/posthog-privacy.md). Adding a key that
 * carries user location, query, IP, or raw error/stack data is the one way to
 * leak; the default is safe.
 *
 * ## Fire-and-forget / shutdown
 * Uses `@logtape/otel`'s shortcut exporter mode (`{ serviceName,
 * otlpExporterConfig: { url, headers } }`), which builds the OTel
 * `LoggerProvider`/batch exporter internally. Core therefore imports no
 * `@opentelemetry/*` packages directly (they resolve transitively through
 * `@logtape/otel`). The exporter batches and flushes on a timer; the server's
 * `registerGracefulShutdown` calls `process.exit(0)`, which may drop an
 * in-flight batch. This matches the fire-and-forget posture — logging must
 * never block shutdown, and the console sink retains the authoritative copy
 * either way. Error/fatal alerting is handled downstream by PostHog (see
 * docs/posthog-privacy.md), not by an in-process transport.
 */
import type { LogRecord, Sink } from "@logtape/logtape";
import { getOpenTelemetrySink } from "@logtape/otel";

const REDACTED = "[redacted]";

/**
 * Property keys permitted to leave the instance in `record.properties`; every
 * other key is scrubbed to `"[redacted]"` at egress. Add a key here ONLY once
 * it is known to carry no user location, query, IP, or raw error/stack data.
 *
 * Covers: identifiers and routing, counts and durations, response metadata,
 * and the resolved server config logged once at boot.
 */
export const DEFAULT_ALLOW_KEYS = [
	// identifiers & routing
	"service",
	"event",
	"conversationId",
	"method",
	"path",
	// counts & durations
	"statusCode",
	"durationMs",
	"waitMs",
	"queryLength",
	"queueSize",
	"pending",
	"evictedCount",
	"windowCount",
	"requestCount",
	"maxRequests",
	"retryAfterMs",
	"count",
	"missingUsage",
	// response metadata
	"contentType",
	// resolved server config (logged once at boot by `logResolvedConfig`)
	"host",
	"port",
	"model",
	"thinkingLevel",
	"dbFile",
	"cacheSize",
	"httpRateLimit",
	"httpRateLimitWindowMs",
	"trustProxy",
	"trustedProxyHops",
	"conversationTokenBudget",
	"apiKey",
	"posthogApiKey",
	"contactEmail",
	"overpassUrl",
	"nominatimUrl",
	"userAgent",
	"nominatimConcurrency",
	"nominatimIntervalCap",
	"nominatimIntervalMs",
	"nominatimTimeoutMs",
	"overpassConcurrency",
	"overpassIntervalCap",
	"overpassIntervalMs",
	"overpassTimeoutMs",
] as const;

/**
 * Return a copy of `record` with any property NOT in `allowKeys` replaced by
 * `"[redacted]"`.
 *
 * Pure: never mutates the input (the console sink must still see full detail).
 * Returns the **same** record reference when every property is allowed — no
 * allocation, no scrubbing needed.
 */
export function allowlistRecord(record: LogRecord, allowKeys: readonly string[]): LogRecord {
	const allow = new Set(allowKeys);
	let disallowed = false;
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record.properties)) {
		if (allow.has(key)) {
			filtered[key] = value;
		} else {
			filtered[key] = REDACTED;
			disallowed = true;
		}
	}
	return disallowed ? { ...record, properties: filtered } : record;
}

export interface PostHogLogsSinkOptions {
	/** Full OTLP/HTTP ingest URL, e.g. `https://eu.i.posthog.com/i/v1/logs`. */
	endpoint: string;
	/** PostHog project token (server-side secret). Sent as `Authorization: Bearer <token>`. */
	token: string;
	/** OTel `service.name`. Default `"pixies-server"`. */
	serviceName?: string;
	/** Property keys permitted at egress; all others are scrubbed. Default {@link DEFAULT_ALLOW_KEYS}. */
	allowKeys?: readonly string[];
}

/**
 * Build a LogTape sink that forwards `info`+ records to PostHog Logs over
 * OTLP/HTTP, shipping only `allowKeys` from each record's properties and
 * scrubbing the rest. Off when unset (the server only builds this when a
 * PostHog key is configured). Uses `@logtape/otel`'s shortcut exporter mode
 * so core imports no `@opentelemetry/*` packages directly.
 */
export function getPostHogLogsSink(opts: PostHogLogsSinkOptions): Sink {
	const otelSink = getOpenTelemetrySink({
		serviceName: opts.serviceName ?? "pixies-server",
		otlpExporterConfig: {
			url: opts.endpoint,
			headers: { Authorization: `Bearer ${opts.token}` },
		},
	});
	const allowKeys = opts.allowKeys ?? DEFAULT_ALLOW_KEYS;
	return (record: LogRecord): void => {
		otelSink(allowlistRecord(record, allowKeys));
	};
}
