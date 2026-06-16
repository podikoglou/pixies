/**
 * Structured logger factory built on pino's `multistream`.
 *
 * Every log line goes to `process.stdout`. When a `discordWebhookUrl` is
 * provided, `error` and `fatal` lines are *additionally* forwarded to a
 * {@link DiscordTransport} (fire-and-forget, never blocks the request path).
 *
 * Why `multistream` and not worker-thread `pino.transport()`: worker transports
 * add Bun-compat risk and complicate `fetch` injection, and our transport is
 * already non-blocking. See {@link DiscordTransport} for the full rationale.
 *
 * `process.stdout` (not `pino.destination(1)`) keeps this dependency-free and
 * works identically under Node and Bun; sonic-boom destinations would add Bun
 * surface area we don't need.
 */
import pino, { type Level, type Logger, type StreamEntry } from "pino";
import { DiscordTransport } from "./discord-transport.ts";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
	/** Logger name embedded in every line. Default `"pixies"`. */
	name?: string;
	/** Minimum level emitted to stdout. Default `"info"`. */
	level?: Level;
	/** When set, `error`+ lines are also POSTed to Discord. */
	discordWebhookUrl?: string;
	/** Injectable fetch for {@link DiscordTransport} (tests never hit network). */
	fetch?: typeof globalThis.fetch;
}

/**
 * Silent no-op logger — safe default for tests / opt-out. Immutable and
 * stateless, so a module-level constant is fine.
 */
export const silentLogger: Logger = pino({ level: "silent" });

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
	const level = opts.level ?? "info";
	const streams: StreamEntry<Level>[] = [{ level, stream: process.stdout }];
	if (opts.discordWebhookUrl) {
		streams.push({
			level: "error", // ONLY error & fatal reach Discord
			stream: new DiscordTransport({ url: opts.discordWebhookUrl, fetch: opts.fetch }),
		});
	}
	return pino({ name: opts.name ?? "pixies", level }, pino.multistream(streams));
}
