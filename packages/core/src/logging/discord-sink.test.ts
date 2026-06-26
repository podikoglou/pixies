/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { getDiscordSink, formatDiscordPayload } from "./discord-sink.ts";

/** A fetch-shaped mock: bun infers call args as `[input, init?]`. */
type FetchMock = ReturnType<typeof mock<(input: string, init?: RequestInit) => Promise<Response>>>;

/** Returns a fetch mock that always resolves with a 204 (Discord success). */
function okFetch(): FetchMock {
	return mock(() => Promise.resolve(new Response(null, { status: 204 })));
}

/** Cast any fetch mock to the full `typeof fetch` the sink expects. */
const asFetch = (fn: FetchMock): typeof fetch => fn as unknown as typeof fetch;

/** Build a real LogTape LogRecord for tests. */
function record(
	level: LogRecord["level"],
	message: string,
	properties: Record<string, unknown> = {},
	timestamp = 1_700_000_000_000,
): LogRecord {
	return {
		category: ["pixies"],
		level,
		message: [message],
		rawMessage: message,
		timestamp,
		properties,
	};
}

/** Promote the next macrotask so fire-and-forget POSTs settle. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- 1. error-level record fires fetch --------------------------------------

test("error-level record POSTs to Discord with an embed body", async () => {
	const fetchFn = okFetch();
	const sink = getDiscordSink({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});

	sink(record("error", "something failed", { conversationId: "abc" }));

	expect(fetchFn).toHaveBeenCalledTimes(1);
	const [calledUrl, init] = fetchFn.mock.calls[0]!;
	expect(calledUrl).toBe("https://discord.test/api/webhooks/x");
	expect(init?.method).toBe("POST");
	const body = JSON.parse(init?.body as string);
	expect(body.username).toBe("pixies");
	expect(body.embeds[0].title).toBe("pixies — error");
	expect(body.embeds[0].description).toBe("something failed");
	expect(body.embeds[0].color).toBe(0xed4245);
});

// ---- 2. info-level record does NOT fire fetch -------------------------------

test("info-level record is filtered out (no fetch)", async () => {
	const fetchFn = okFetch();
	const sink = getDiscordSink({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});

	sink(record("info", "just info"));

	expect(fetchFn).not.toHaveBeenCalled();
});

// ---- 3. fatal-level formatting ----------------------------------------------

test("fatal-level record gets fatal title, black color, and record timestamp", async () => {
	const fetchFn = okFetch();
	const sink = getDiscordSink({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});
	const time = 1_700_000_000_000;

	sink(record("fatal", "catastrophe", {}, time));

	expect(fetchFn).toHaveBeenCalledTimes(1);
	const [, init] = fetchFn.mock.calls[0]!;
	const body = JSON.parse(init?.body as string);
	expect(body.embeds[0].title).toBe("pixies — fatal");
	expect(body.embeds[0].color).toBe(0x000000);
	expect(body.embeds[0].timestamp).toBe(new Date(time).toISOString());
});

// ---- 4. fetch rejection is swallowed (never crashes the app) ----------------

test("fetch rejection is swallowed (no throw)", async () => {
	const failingFetch = mock(() => Promise.reject(new Error("network down")));
	const sink = getDiscordSink({
		url: "https://discord.test/api/webhooks/x",
		fetch: failingFetch as unknown as typeof fetch,
	});

	// Should not throw — the sink catches internally.
	expect(() => sink(record("error", "still logs"))).not.toThrow();
	// Allow the rejected promise's .catch/.finally to run without throwing.
	await settle();
});

// ---- 5. concurrency cap drops extras ----------------------------------------

test("drops POSTs beyond maxConcurrent to avoid fetch storms", async () => {
	const fetchFn = okFetch();
	const sink = getDiscordSink({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
		maxConcurrent: 2,
	});

	// Push maxConcurrent + 2 synchronously; only maxConcurrent should fire.
	for (let i = 0; i < 4; i++) sink(record("error", `err ${i}`));
	await settle();

	expect(fetchFn).toHaveBeenCalledTimes(2);
});

// ---- formatDiscordPayload unit tests ----------------------------------------

test("formatDiscordPayload promotes extra context to inline fields", () => {
	const payload = formatDiscordPayload(
		record("error", "failed to persist transcript", {
			conversationId: "id-123",
			pid: 1,
			hostname: "vps",
			name: "pixies",
			err: { message: "boom", stack: "Error: boom\n  at foo" },
		}),
	);

	const fields = payload.embeds[0]!.fields as Array<{ name: string; value: string }>;
	const names = fields.map((f) => f.name);
	// conversationId becomes a field; err does not (it is surfaced as stack).
	expect(names).toContain("conversationId");
	expect(names).not.toContain("err");
	// stack is appended as its own field, wrapped in a code block.
	const stackField = fields.find((f) => f.name === "stack");
	expect(stackField?.value).toContain("```");
	expect(stackField?.value).toContain("Error: boom");
});

test("formatDiscordPayload uses a placeholder when message is empty", () => {
	const payload = formatDiscordPayload(record("error", ""));
	expect(payload.embeds[0]!.description).toBe("(no message)");
});

test("formatDiscordPayload never exceeds Discord's 25-field limit", () => {
	// 25 non-reserved context keys + an err.stack would previously yield 26
	// fields and Discord would reject the embed with a silent 400.
	const properties: Record<string, unknown> = {
		err: { stack: "Error: boom\n  at foo" },
	};
	for (let i = 0; i < 25; i++) properties[`key${i}`] = `value${i}`;

	const payload = formatDiscordPayload(record("error", "many fields", properties));
	const fields = payload.embeds[0]!.fields as Array<{ name: string; value: string }>;

	expect(fields.length).toBe(25);
	// The stack is reserved a slot — always present, never the cause of overflow.
	const names = fields.map((f) => f.name);
	expect(names).toContain("stack");
});

test("formatDiscordPayload fills all 25 slots with context when no stack is present", () => {
	const properties: Record<string, unknown> = {};
	for (let i = 0; i < 25; i++) properties[`key${i}`] = `value${i}`;

	const payload = formatDiscordPayload(record("error", "no stack", properties));
	const fields = payload.embeds[0]!.fields as Array<{ name: string; value: string }>;

	expect(fields.length).toBe(25);
	expect(fields.map((f) => f.name)).not.toContain("stack");
});
