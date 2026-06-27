/**
 * Structured logger factory built on LogTape.
 *
 * Every log line goes to the console. When a `posthogSink` is provided (e.g.
 * {@link getPostHogLogsSink}), `info`+ lines are *additionally* shipped to
 * PostHog Logs over OTel (redacted at the egress sink, off when unset).
 *
 * LogTape is configured exactly once per process via `configureSync`
 * (guarded by the module-level `configured` flag). Library code MUST NOT call
 * `configureSync`; only the app (the server) drives it through `createLogger`.
 */
import {
	configureSync,
	getConsoleSink,
	getLogger,
	type Logger,
	type LogLevel,
	type Sink,
} from "@logtape/logtape";

export type { Logger } from "@logtape/logtape";

export interface CreateLoggerOptions {
	/** Logger category embedded in every line. Default `"pixies"`. */
	name?: string;
	/** Minimum level emitted to the console. Default `"info"`. */
	level?: LogLevel;
	/** Optional sink for `info`+ log lines shipped off-instance (e.g. {@link getPostHogLogsSink}). */
	posthogSink?: Sink;
}

/**
 * Silent logger — safe default for tests / opt-out. Obtained before any
 * `configureSync` so it routes nowhere; the `["pixies", "silent"]` entry in
 * {@link createLogger} keeps it silent even after configuration (no sinks,
 * override parent sinks). Immutable and stateless, so a module-level constant
 * is fine.
 */
export const silentLogger: Logger = getLogger(["pixies", "silent"]);

let configured = false;

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
	const root = opts.name ?? "pixies";
	const level = opts.level ?? "info";
	if (!configured) {
		const sinks: Record<string, Sink> = { console: getConsoleSink() };
		const rootSinks = ["console"];
		if (opts.posthogSink) {
			sinks.posthog = opts.posthogSink;
			rootSinks.push("posthog");
		}
		configureSync({
			sinks,
			loggers: [
				{
					category: [root],
					lowestLevel: level,
					sinks: rootSinks,
				},
				// Forces silent: no own sinks, do not inherit parent sinks, and
				// reject anything below fatal anyway.
				{
					category: ["pixies", "silent"],
					lowestLevel: "fatal",
					sinks: [],
					parentSinks: "override",
				},
			],
		});
		configured = true;
	}
	return getLogger([root]);
}
