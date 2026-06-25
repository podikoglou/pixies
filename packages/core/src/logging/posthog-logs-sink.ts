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
 * ## Redaction at egress (defense-in-depth)
 * The console sink keeps every field verbatim; **only this egress path
 * scrubs** the `url` and `query` properties (default, see
 * {@link DEFAULT_REDACT_KEYS}). Today the only location-encoding fields are
 * Nominatim request URLs (`?q=<place name>`) logged at `debug`, which the
 * root logger's `info` threshold already drops before this sink is reached.
 * Redaction is still required as defense-in-depth: it protects against (a) an
 * operator raising the level to `debug`, and (b) future info+ fields that may
 * carry location data. Any new server log field that could carry location data
 * MUST be added to `redactKeys` (see docs/posthog-privacy.md).
 *
 * ## Fire-and-forget / shutdown
 * Uses `@logtape/otel`'s shortcut exporter mode (`{ serviceName,
 * otlpExporterConfig: { url, headers } }`), which builds the OTel
 * `LoggerProvider`/batch exporter internally. Core therefore imports no
 * `@opentelemetry/*` packages directly (they resolve transitively through
 * `@logtape/otel`). The exporter batches and flushes on a timer; the server's
 * `registerGracefulShutdown` calls `process.exit(0)`, which may drop an
 * in-flight batch. This matches the DiscordTransport fire-and-forget posture
 * — logging must never block shutdown, and the console sink retains the
 * authoritative copy either way.
 */
import type { LogRecord, Sink } from "@logtape/logtape";
import { getOpenTelemetrySink } from "@logtape/otel";

/** Keys scrubbed from `record.properties` before egress to PostHog Cloud. */
export const DEFAULT_REDACT_KEYS = ["url", "query"] as const;

const REDACTED = "[redacted]";

/**
 * Return a copy of `record` with any property in `keys` replaced by
 * `"[redacted]"`.
 *
 * Pure: never mutates the input (the console sink must still see full detail).
 * Returns the **same** record reference when nothing matches — no allocation,
 * no scrubbing needed.
 */
export function redactRecord(record: LogRecord, keys: readonly string[]): LogRecord {
	let matched = false;
	const redacted: Record<string, unknown> = { ...record.properties };
	for (const key of keys) {
		if (key in redacted) {
			redacted[key] = REDACTED;
			matched = true;
		}
	}
	return matched ? { ...record, properties: redacted } : record;
}

export interface PostHogLogsSinkOptions {
	/** Full OTLP/HTTP ingest URL, e.g. `https://eu.i.posthog.com/i/v1/logs`. */
	endpoint: string;
	/** PostHog project token (server-side secret). Sent as `Authorization: Bearer <token>`. */
	token: string;
	/** OTel `service.name`. Default `"pixies-server"`. */
	serviceName?: string;
	/** Property keys to scrub before egress. Default `["url", "query"]`. */
	redactKeys?: readonly string[];
}

/**
 * Build a LogTape sink that forwards `info`+ records to PostHog Logs over
 * OTLP/HTTP, scrubbing `redactKeys` from each record's properties first. Off
 * when unset (the server only builds this when a PostHog key is configured).
 * Uses `@logtape/otel`'s shortcut exporter mode so core imports no
 * `@opentelemetry/*` packages directly.
 */
export function getPostHogLogsSink(opts: PostHogLogsSinkOptions): Sink {
	const otelSink = getOpenTelemetrySink({
		serviceName: opts.serviceName ?? "pixies-server",
		otlpExporterConfig: {
			url: opts.endpoint,
			headers: { Authorization: `Bearer ${opts.token}` },
		},
	});
	const keys = opts.redactKeys ?? DEFAULT_REDACT_KEYS;
	return (record: LogRecord): void => {
		otelSink(redactRecord(record, keys));
	};
}
