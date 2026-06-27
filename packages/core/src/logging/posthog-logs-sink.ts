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
 * scrubs** the `url`, `query`, `cause`, and `err` properties (default, see
 * {@link DEFAULT_REDACT_KEYS}). Today the only location-encoding fields are
 * Nominatim request URLs (`?q=<place name>`) logged at `debug`, which the
 * root logger's `info` threshold already drops before this sink is reached.
 * Redaction is still required as defense-in-depth: it protects against (a) an
 * operator raising the level to `debug`, and (b) future info+ fields that may
 * carry location data. Any new server log field that could carry location data
 * MUST be added to `redactKeys` (see docs/posthog-privacy.md).
 *
 * `cause` is scrubbed because the Overpass/Nominatim "invalid response shape"
 * warnings (info+) attach the TypeBox `Value.Parse` error there, and that
 * error's `cause` is `{ source, errors, value }` where `value` is the **entire
 * parsed response** — place names, OSM tags, coordinates. `@logtape/otel`'s
 * default `semconv` `exceptionMode` emits only `exception.type`/`.message`/
 * `.stacktrace` and never reads `.cause`, so this does NOT leak today. But in
 * `raw` `exceptionMode` (or if the default ever flips), `serializeValue` reads
 * `.cause` directly regardless of enumerability and would ship the payload.
 * Scrubbing the record's top-level `cause` removes the error (and its nested
 * payload) before OTLP ever sees it, regardless of mode — defense-in-depth
 * that does not depend on the active `exceptionMode`. Local stdout retains
 * full detail for debugging.
 *
 * `err` is scrubbed wherever it appears: the live `Error` object it carries is
 * walked verbatim by `@logtape/otel`, so any `err`-keyed log is a potential
 * payload carrier. The concrete case is `agent stream error`
 * (`packages/server/src/stream-instrumentation.ts`): an Overpass/Nominatim
 * `*ParseError`/`*HttpError` re-thrown verbatim by `recoverBusyOrThrow`
 * reaches `StreamInstrumentation.fail`, which logs it as `{ err }`. That
 * `TaggedError`'s `.cause` is the same TypeBox parse error (its nested `.value`
 * is the full response), and in `raw` `exceptionMode` `serializeValue`
 * recurses `.cause` and ships the payload via the `err` key — a path the
 * top-level `cause` entry above does not cover (`err` is a different key).
 * Scrubbing `err` wholesale also drops its `.message`, which for `*HttpError`
 * embeds the OSM response body. Local stdout retains the full object; the
 * analytics capture is already tag-only, so this aligns the logs path with it.
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

/**
 * Keys scrubbed from `record.properties` before egress to PostHog Cloud.
 *
 * - `url`, `query` — Nominatim request URLs encode the `q=<place>` parameter.
 * - `cause` — TypeBox parse errors carry the full parsed response (place
 *   names) in their nested `cause.value`; see the file-level redaction note.
 * - `err` — the live `Error` object logged at `agent stream error` (and any
 *   other `err`-keyed log) whose `.cause` chain / `.message` can carry the
 *   same payload; see the file-level redaction note.
 */
export const DEFAULT_REDACT_KEYS = ["url", "query", "cause", "err"] as const;

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
	/** Property keys to scrub before egress. Defaults to {@link DEFAULT_REDACT_KEYS}. */
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
