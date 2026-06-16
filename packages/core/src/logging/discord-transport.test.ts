/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { DiscordTransport, formatDiscordPayload } from "./discord-transport.ts";

/** A fetch-shaped mock: bun infers call args as `[input, init?]`. */
type FetchMock = ReturnType<typeof mock<(input: string, init?: RequestInit) => Promise<Response>>>;

/** Returns a fetch mock that always resolves with a 204 (Discord success). */
function okFetch(): FetchMock {
	return mock(() => Promise.resolve(new Response(null, { status: 204 })));
}

/** Cast any fetch mock to the full `typeof fetch` the transport expects. */
const asFetch = (fn: FetchMock): typeof fetch => fn as unknown as typeof fetch;

/** A pino-shaped error-level JSON line as a UTF-8 buffer. */
function line(entry: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify({ level: 50, msg: "boom", ...entry })}\n`, "utf8");
}

/** Promote the next macrotask so fire-and-forget POSTs settle. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Write a chunk synchronously and wait for the stream's write callback. */
function writeSync(stream: DiscordTransport, chunk: Buffer): Promise<void> {
	return new Promise((resolve) => stream.write(chunk, () => resolve()));
}

// ---- 1. error-level entry fires fetch ---------------------------------------

test("error-level entry POSTs to Discord with an embed body", async () => {
	const fetchFn = okFetch();
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});

	await writeSync(transport, line({ msg: "something failed", conversationId: "abc" }));

	expect(fetchFn).toHaveBeenCalledTimes(1);
	const [calledUrl, init] = fetchFn.mock.calls[0]!;
	expect(calledUrl).toBe("https://discord.test/api/webhooks/x");
	expect(init?.method).toBe("POST");
	const body = JSON.parse(init?.body as string);
	expect(body.username).toBe("pixies");
	expect(body.embeds[0].title).toBe("🚨 pixies — error");
	expect(body.embeds[0].description).toBe("something failed");
	expect(body.embeds[0].color).toBe(0xed4245);
});

// ---- 2. info-level entry does NOT fire fetch --------------------------------

test("info-level entry is filtered out (no fetch)", async () => {
	const fetchFn = okFetch();
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});

	await writeSync(
		transport,
		Buffer.from(`${JSON.stringify({ level: 30, msg: "just info" })}\n`, "utf8"),
	);

	expect(fetchFn).not.toHaveBeenCalled();
});

// ---- 3. malformed JSON does not throw and does not fetch --------------------

test("malformed JSON chunk is swallowed (no throw, no fetch)", async () => {
	const fetchFn = okFetch();
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});

	await expect(
		writeSync(transport, Buffer.from("{not valid json\n", "utf8")),
	).resolves.toBeUndefined();

	expect(fetchFn).not.toHaveBeenCalled();
});

// ---- 4. fetch rejection is swallowed (never crashes the app) ---------------

test("fetch rejection is swallowed (no throw)", async () => {
	const failingFetch = mock(() => Promise.reject(new Error("network down")));
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: failingFetch as unknown as typeof fetch,
	});

	// Should not reject — the transport catches internally.
	await expect(writeSync(transport, line({ msg: "still logs" }))).resolves.toBeUndefined();
	// Allow the rejected promise's .catch/.finally to run without throwing.
	await settle();
});

// ---- 5. concurrency cap drops extras ----------------------------------------

test("drops POSTs beyond maxConcurrent to avoid fetch storms", async () => {
	const fetchFn = okFetch();
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
		maxConcurrent: 2,
	});

	// Push maxConcurrent + 2 synchronously; only maxConcurrent should fire.
	for (let i = 0; i < 4; i++) {
		transport.write(line({ msg: `err ${i}` }));
	}
	await settle();

	expect(fetchFn).toHaveBeenCalledTimes(2);
});

// ---- 6. fatal-level formatting ----------------------------------------------

test("fatal-level (60) entry gets fatal title and black color", async () => {
	const fetchFn = okFetch();
	const transport = new DiscordTransport({
		url: "https://discord.test/api/webhooks/x",
		fetch: asFetch(fetchFn),
	});
	const time = 1_700_000_000_000;

	await writeSync(
		transport,
		Buffer.from(`${JSON.stringify({ level: 60, msg: "catastrophe", time })}\n`, "utf8"),
	);

	expect(fetchFn).toHaveBeenCalledTimes(1);
	const [, init] = fetchFn.mock.calls[0]!;
	const body = JSON.parse(init?.body as string);
	expect(body.embeds[0].title).toBe("🚨 pixies — fatal");
	expect(body.embeds[0].color).toBe(0x000000);
	expect(body.embeds[0].timestamp).toBe(new Date(time).toISOString());
});

// ---- formatDiscordPayload unit tests ----------------------------------------

test("formatDiscordPayload promotes extra context to inline fields", () => {
	const payload = formatDiscordPayload({
		level: 50,
		msg: "failed to persist transcript",
		conversationId: "id-123",
		pid: 1,
		hostname: "vps",
		name: "pixies",
		err: { message: "boom", stack: "Error: boom\n  at foo" },
	});

	const fields = payload.embeds[0]!.fields as Array<{ name: string; value: string }>;
	const names = fields.map((f) => f.name);
	// conversationId becomes a field; reserved pino keys do not.
	expect(names).toContain("conversationId");
	for (const reserved of ["level", "msg", "pid", "hostname", "name", "err"]) {
		expect(names).not.toContain(reserved);
	}
	// stack is appended as its own field, wrapped in a code block.
	const stackField = fields.find((f) => f.name === "stack");
	expect(stackField?.value).toContain("```");
	expect(stackField?.value).toContain("Error: boom");
});

test("formatDiscordPayload uses a placeholder when msg is absent", () => {
	const payload = formatDiscordPayload({ level: 50 });
	expect(payload.embeds[0]!.description).toBe("(no message)");
});
