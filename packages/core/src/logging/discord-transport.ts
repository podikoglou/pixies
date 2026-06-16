/**
 * Discord webhook transport for pino.
 *
 * A {@link Writable} that receives one JSON-serialized pino log line per
 * `write()`. It parses the line, defensively re-checks that the level is
 * `error` or above (the multistream already filters by level, but this guards
 * against accidental misconfiguration), and fires a **non-blocking** POST to a
 * Discord webhook formatted as an embed.
 */
import { Writable } from "node:stream";

export interface DiscordTransportOptions {
	url: string;
	/** Defaults to `globalThis.fetch`. Injected in tests. */
	fetch?: typeof globalThis.fetch;
	/** Max in-flight POSTs; extras are dropped. Default 5. */
	maxConcurrent?: number;
}

/** pino numeric levels: error = 50, fatal = 60. */
const ERROR_LEVEL = 50;
const FATAL_LEVEL = 60;

/** Discord embed color: red (#ed4245) for error, black for fatal. */
const COLOR_ERROR = 0xed4245;
const COLOR_FATAL = 0x000000;

/** Discord limits. */
const MAX_DESCRIPTION = 4000;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;

/** Keys pino emits that should NOT be promoted to Discord embed fields. */
const RESERVED_KEYS = new Set(["level", "msg", "time", "pid", "hostname", "name", "v", "err"]);

/** Shape of a parsed pino log line (only the fields we care about are typed). */
interface PinoLogEntry {
	level?: number;
	msg?: unknown;
	time?: number;
	err?: { message?: string; stack?: string; type?: string };
	[key: string]: unknown;
}

export class DiscordTransport extends Writable {
	private readonly url: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly maxConcurrent: number;
	private inFlight = 0;

	constructor(opts: DiscordTransportOptions) {
		super(); // string/buffer mode (NOT objectMode) — pino writes JSON strings
		this.url = opts.url;
		this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
		this.maxConcurrent = opts.maxConcurrent ?? 5;
	}

	override _write(chunk: unknown, _enc: string, done: (error?: Error | null) => void): void {
		const line = String(chunk).trim();
		if (!line) return done();

		let entry: PinoLogEntry;
		try {
			entry = JSON.parse(line) as PinoLogEntry;
		} catch {
			// Malformed JSON — never let a bad log line crash the app.
			return done();
		}

		// Defensive: multistream already filters by level, but re-check so a
		// misconfigured stream (or direct writes) never spam Discord.
		if ((entry.level ?? 0) < ERROR_LEVEL) return done();

		// Drop under fetch storms; the entry is still on stdout.
		if (this.inFlight >= this.maxConcurrent) return done();

		this.inFlight++;
		void this.post(entry)
			.catch(() => {
				/* never let logging crash the app */
			})
			.finally(() => {
				this.inFlight--;
			});
		done(); // fire-and-forget: do NOT block pino on the network
	}

	private async post(entry: PinoLogEntry): Promise<void> {
		const body = formatDiscordPayload(entry);
		const res = await this.fetchFn(this.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// Discord returns 204 on success; 429 = rate limited. v1 does not retry;
		// drop and rely on stdout logs. Non-ok responses are swallowed to avoid
		// recursive logging.
		if (!res.ok && res.status !== 429) {
			// intentionally swallowed
		}
	}
}

/** Truncate a string to `max` chars, appending an ellipsis when truncated. */
function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Build a Discord webhook payload (single embed) from a pino log entry.
 *
 * Deterministic and readable: title/description reflect the message, color +
 * timestamp reflect severity and time, structured fields surface extra context
 * (e.g. `conversationId`), and the error stack is appended in a code block.
 */
export function formatDiscordPayload(entry: PinoLogEntry): {
	username: string;
	embeds: Array<Record<string, unknown>>;
} {
	const isFatal = (entry.level ?? 0) >= FATAL_LEVEL;
	const severity = isFatal ? "fatal" : "error";

	const embed: Record<string, unknown> = {
		title: `pixies — ${severity}`,
		description: truncate(String(entry.msg ?? "(no message)"), MAX_DESCRIPTION),
		color: isFatal ? COLOR_FATAL : COLOR_ERROR,
	};

	if (typeof entry.time === "number" && Number.isFinite(entry.time)) {
		embed.timestamp = new Date(entry.time).toISOString();
	}

	const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

	for (const [key, value] of Object.entries(entry)) {
		if (fields.length >= MAX_FIELDS) break;
		if (RESERVED_KEYS.has(key)) continue;
		fields.push({
			name: truncate(key, 256),
			value: truncate(String(value), MAX_FIELD_VALUE),
			inline: true,
		});
	}

	if (entry.err?.stack) {
		fields.push({
			name: "stack",
			value: truncate(`\`\`\`\n${entry.err.stack}\n\`\`\``, MAX_FIELD_VALUE),
		});
	}

	if (fields.length > 0) embed.fields = fields;

	return { username: "pixies", embeds: [embed] };
}
