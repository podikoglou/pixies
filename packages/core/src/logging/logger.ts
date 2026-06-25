/**
 * Structured logger factory built on LogTape.
 *
 * Every log line goes to the console. When a `discordSink` is provided (e.g.
 * {@link getDiscordSink}), `error`+ lines are *additionally* forwarded to it
 * (the sink self-filters and fires non-blocking, never blocking the request
 * path).
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
	/** Optional sink for `error`+ log lines (e.g. {@link getDiscordSink}). */
	discordSink?: Sink;
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
		if (opts.discordSink) {
			sinks.discord = opts.discordSink;
			rootSinks.push("discord");
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
