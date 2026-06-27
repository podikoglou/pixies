/**
 * Discord webhook sink for LogTape.
 *
 * A {@link Sink} that receives a {@link LogRecord}. It defensively re-checks
 * that the level is `error` or `fatal` (the root logger's `discord` sink is
 * only attached for `error`+, but this guards against accidental
 * misconfiguration or direct invocation), and fires a **non-blocking** POST
 * to a Discord webhook formatted as an embed.
 */
import type { LogRecord, Sink } from "@logtape/logtape";

export interface DiscordSinkOptions {
	url: string;
	/** Defaults to `globalThis.fetch`. Injected in tests. */
	fetch?: typeof globalThis.fetch;
	/** Max in-flight POSTs; extras are dropped. Default 5. */
	maxConcurrent?: number;
}

/** Discord embed color: red (#ed4245) for error, black for fatal. */
const COLOR_ERROR = 0xed4245;
const COLOR_FATAL = 0x000000;

/** Discord limits. */
const MAX_DESCRIPTION = 4000;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;

/**
 * Build a Discord webhook sink. The sink self-filters to `error`+ and
 * fire-and-forgets the POST; rejections are swallowed so logging never crashes
 * the app. Beyond `maxConcurrent` (default 5) in-flight POSTs are dropped —
 * the entry is still on the console sink.
 */
export function getDiscordSink(opts: DiscordSinkOptions): Sink {
	const url = opts.url;
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
	const maxConcurrent = opts.maxConcurrent ?? 5;
	let inFlight = 0;

	async function post(record: LogRecord): Promise<void> {
		const body = formatDiscordPayload(record);
		const res = await fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// Discord returns 204 on success; 429 = rate limited. v1 does not retry;
		// drop and rely on console logs. Non-ok responses are swallowed to avoid
		// recursive logging.
		if (!res.ok && res.status !== 429) {
			// intentionally swallowed
		}
	}

	return (record: LogRecord): void => {
		// Defensive: re-check so a misconfigured stream (or direct invocation)
		// never spams Discord.
		if (record.level !== "error" && record.level !== "fatal") return;

		// Drop under fetch storms; the entry is still on the console sink.
		if (inFlight >= maxConcurrent) return;

		inFlight++;
		void post(record)
			.catch(() => {
				/* never let logging crash the app */
			})
			.finally(() => {
				inFlight--;
			});
	};
}

/** Truncate a string to `max` chars, appending an ellipsis when truncated. */
function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Build a Discord webhook payload (single embed) from a LogTape record.
 *
 * Deterministic and readable: title/description reflect the message, color +
 * timestamp reflect severity and time, structured fields surface extra context
 * (e.g. `conversationId`), and the error stack is appended in a code block.
 */
export function formatDiscordPayload(record: LogRecord): {
	username: string;
	embeds: Array<Record<string, unknown>>;
} {
	const isFatal = record.level === "fatal";
	const severity = isFatal ? "fatal" : "error";

	const embed: Record<string, unknown> = {
		title: `pixies — ${severity}`,
		description: truncate(String(record.message.join("") || "(no message)"), MAX_DESCRIPTION),
		color: isFatal ? COLOR_FATAL : COLOR_ERROR,
	};

	// `record.timestamp` is ms since the Unix epoch (see LogTape's LogRecord).
	if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
		embed.timestamp = new Date(record.timestamp).toISOString();
	}

	const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

	const err = record.properties.err as { stack?: string } | Error | undefined;
	const stack = err && typeof err === "object" ? err.stack : undefined;

	// When a stack will be appended below, reserve one of the 25 slots so the
	// stack (the most important field for an error alert) is never dropped and
	// the embed never exceeds Discord's 25-field limit.
	const hasStack = Boolean(stack);
	const contextCap = hasStack ? MAX_FIELDS - 1 : MAX_FIELDS;

	for (const [key, value] of Object.entries(record.properties)) {
		if (fields.length >= contextCap) break;
		if (key === "err") continue; // surfaced as the stack field, not an inline field
		fields.push({
			name: truncate(key, 256),
			value: truncate(String(value), MAX_FIELD_VALUE),
			inline: true,
		});
	}

	if (stack) {
		fields.push({
			name: "stack",
			value: truncate(`\`\`\`\n${stack}\n\`\`\``, MAX_FIELD_VALUE),
		});
	}

	if (fields.length > 0) embed.fields = fields;

	return { username: "pixies", embeds: [embed] };
}
