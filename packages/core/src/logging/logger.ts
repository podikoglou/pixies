/**
 * Structured logger factory built on pino's `multistream`.
 *
 * Every log line goes to `process.stdout`. When a `discordTransport` writable
 * stream is provided (e.g. {@link DiscordTransport}), `error` and `fatal` lines
 * are *additionally* forwarded to it (fire-and-forget, never blocks the request
 * path).
 *
 * Why `multistream` and not worker-thread `pino.transport()`: worker transports
 * add Bun-compat risk and complicate `fetch` injection, and our transport is
 * already non-blocking. See {@link DiscordTransport} for the full rationale.
 *
 * `process.stdout` (not `pino.destination(1)`) keeps this dependency-free and
 * works identically under Node and Bun; sonic-boom destinations would add Bun
 * surface area we don't need.
 */
import type { Writable } from "node:stream";
import pino, { type Level, type Logger, type StreamEntry } from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
	/** Logger name embedded in every line. Default `"pixies"`. */
	name?: string;
	/** Minimum level emitted to stdout. Default `"info"`. */
	level?: Level;
	/** Optional writable stream for `error`+ log lines (e.g. {@link DiscordTransport}). */
	discordTransport?: Writable;
}

/**
 * Silent no-op logger — safe default for tests / opt-out. Immutable and
 * stateless, so a module-level constant is fine.
 */
export const silentLogger: Logger = pino({ level: "silent" });

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
	const level = opts.level ?? "info";
	const streams: StreamEntry<Level>[] = [{ level, stream: process.stdout }];
	if (opts.discordTransport) {
		streams.push({
			level: "error", // ONLY error & fatal reach Discord
			stream: opts.discordTransport,
		});
	}
	return pino({ name: opts.name ?? "pixies", level }, pino.multistream(streams));
}
