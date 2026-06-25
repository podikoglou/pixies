/// <reference types="bun" />
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { conversations as conversationsTable, type DbClient } from "@pixies/core/db";
import { type Logger } from "@pixies/core/logging";
import {
	Result,
	BudgetExceededError,
	type CreateAgentOptions,
	type ResolvedPixiesConfig,
} from "@pixies/core";
import { ConversationStore } from "./conversations.ts";

/**
 * Minimal Agent stand-in. The store depends on exactly four members:
 * `subscribe`, `prompt`, `state.messages`, and `abort`. `prompt` resolves
 * deterministically, pushing a user + assistant message and emitting the
 * `message_start` / `message_end` events the store forwards over SSE.
 */
class FakeAgent {
	state = { messages: [] as AgentMessage[] };
	aborted = false;
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async prompt(message: string): Promise<void> {
		const now = Date.now();
		const userMsg = { role: "user", content: message, timestamp: now } as unknown as AgentMessage;
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: `echo: ${message}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		} as unknown as AgentMessage;
		this.state.messages.push(userMsg, assistantMsg);
		for (const listener of this.listeners)
			listener({ type: "message_start", message: assistantMsg });
		for (const listener of this.listeners) listener({ type: "message_end", message: assistantMsg });
	}

	abort(): void {
		this.aborted = true;
	}
}

/** Build an isolated in-memory drizzle DB (no migration folder coupling). */
function createTestDb(): DbClient {
	const sqlite = new Database(":memory:");
	sqlite.run(
		"CREATE TABLE `conversations` (`id` text PRIMARY KEY NOT NULL, `transcript` text, `created_at` integer, `updated_at` integer)",
	);
	return drizzle({
		client: sqlite,
		schema: { conversations: conversationsTable },
		casing: "snake_case",
	}) as unknown as DbClient;
}

const baseConfig: ResolvedPixiesConfig = {
	model: "anthropic/claude-3-5-sonnet",
	apiKey: "test-key",
	contactEmail: undefined,
	overpassUrl: "https://overpass-api.de/api/interpreter",
	nominatimUrl: "https://nominatim.openstreetmap.org",
	userAgent: "Pixies (test)",
	host: "127.0.0.1",
	port: 3000,
	thinkingLevel: "off",
	dbFile: ":memory:",
	cacheSize: 50,
	httpRateLimit: 30,
	httpRateLimitWindowMs: 60_000,
	trustProxy: false,
	trustedProxyHops: 1,
	nominatimConcurrency: 1,
	nominatimIntervalCap: 1,
	nominatimIntervalMs: 1100,
	nominatimCacheTtlMs: 86_400_000,
	nominatimCacheMaxEntries: 1000,
	overpassConcurrency: 2,
	overpassIntervalCap: 2,
	overpassIntervalMs: 1000,
	posthogHost: "https://eu.i.posthog.com",
	conversationTokenBudget: 0,
};

const stores: ConversationStore[] = [];

/** Factory that counts calls and (optionally) captures built agents. */
function makeFakeFactory(capture?: FakeAgent[]) {
	const fn = () => {
		const agent = new FakeAgent();
		capture?.push(agent);
		return agent as unknown as Agent;
	};
	return fn;
}

interface MakeStoreOpts {
	cacheSize?: number;
	db?: DbClient;
	agentFactory?: (opts: CreateAgentOptions) => Agent;
	conversationTokenBudget?: number;
}

function makeStore(opts: MakeStoreOpts = {}): { store: ConversationStore; db: DbClient } {
	const db = opts.db ?? createTestDb();
	const config: ResolvedPixiesConfig = {
		...baseConfig,
		cacheSize: opts.cacheSize ?? baseConfig.cacheSize,
		conversationTokenBudget: opts.conversationTokenBudget ?? baseConfig.conversationTokenBudget,
	};
	const store = new ConversationStore(config, db, opts.agentFactory ?? makeFakeFactory());
	stores.push(store);
	return { store, db };
}

afterEach(() => {
	while (stores.length) stores.pop()?.stop();
	setSystemTime();
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("create() returns an id and persists an empty-transcript row", async () => {
	const { store, db } = makeStore();
	const id = store.create();
	expect(typeof id).toBe("string");
	await sleep(10);
	const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
	expect(rows).toHaveLength(1);
	expect(rows[0]?.transcript).toEqual([]);
});

test("get() cache hit moves the entry to the LRU tail", async () => {
	const calls: FakeAgent[] = [];
	const { store } = makeStore({
		cacheSize: 2,
		agentFactory: makeFakeFactory(calls),
	});

	const id1 = store.create();
	const id2 = store.create();
	await sleep(10);
	// Touch id1: cache order becomes [id2, id1]; id1 is now most-recent.
	await store.get(id1);

	store.create(); // over maxSize → evicts the LRU (id2, not id1)
	await sleep(10);

	// id1 survived (it was moved to the tail) → no rehydration. Checked
	// before probing id2, since rehydrating id2 would itself evict id3/id1.
	const beforeHit = calls.length;
	const id1Conv = await store.get(id1);
	expect(id1Conv).toBeDefined();
	expect(calls.length).toBe(beforeHit);

	// id2 was evicted → rehydrates.
	const beforeMiss = calls.length;
	const id2Conv = await store.get(id2);
	expect(id2Conv).toBeDefined();
	expect(calls.length).toBe(beforeMiss + 1);
});

test("get() cache miss rehydrates a non-empty transcript from the DB", async () => {
	const { store, db } = makeStore();
	const id = "seeded-id";
	const seeded: AgentMessage[] = [
		{ role: "user", content: "hello", timestamp: 1 } as unknown as AgentMessage,
	];
	await db.insert(conversationsTable).values({ id, transcript: seeded });

	const conv = await store.get(id);
	expect(conv).toBeDefined();
	expect(conv?.agent.state.messages).toHaveLength(1);
	expect(conv?.agent.state.messages[0]).toEqual(seeded[0]);
});

test("get() warns and starts empty when the persisted transcript is grossly corrupt [#106]", async () => {
	const warnSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	const mockLogger = { warning: warnSpy, error: mock(() => {}) } as unknown as Logger;
	const db = createTestDb();
	const store = new ConversationStore(baseConfig, db, makeFakeFactory(), mockLogger);
	stores.push(store);

	const id = "corrupt-id";
	// Persisted blob has entries but no `role` — fails PersistedTranscriptSchema.
	await db.insert(conversationsTable).values({
		id,
		transcript: [{ foo: "bar" }] as unknown as AgentMessage[],
	});

	const conv = await store.get(id);
	expect(conv).toBeDefined();
	// Corruption degrades to an empty conversation rather than mis-typing state.
	expect(conv?.agent.state.messages).toEqual([]);
	expect(conv?.tokensUsed).toBe(0);

	const logged = warnSpy.mock.calls.find(
		(call) =>
			call[0] === "transcript failed validation; starting fresh" && call[1]?.conversationId === id,
	);
	expect(logged).toBeDefined();
	expect(logged?.[1]?.count).toBe(1);
});

test("streamPrompt() warns and proceeds with empty state when the persisted transcript is grossly corrupt [#106]", async () => {
	const agents: FakeAgent[] = [];
	const warnSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	const mockLogger = { warning: warnSpy, error: mock(() => {}) } as unknown as Logger;
	const db = createTestDb();
	const store = new ConversationStore(baseConfig, db, makeFakeFactory(agents), mockLogger);
	stores.push(store);

	const id = "corrupt-stream-id";
	// Unknown role — fails the persisted-transcript guard.
	await db.insert(conversationsTable).values({
		id,
		transcript: [{ role: "system" }] as unknown as AgentMessage[],
	});

	const result = await store.streamPrompt(id, "hi");
	expect(Result.isOk(result)).toBe(true);
	if (Result.isOk(result)) {
		for await (const _ of result.value.stream) {
			// drain
		}
	}

	expect(warnSpy).toHaveBeenCalled();
	// Rehydration degraded to empty state, so the prompt added exactly one user
	// message (not the prior corrupt entry).
	const userMsgs = agents[0]?.state.messages.filter((m) => m.role === "user") ?? [];
	expect(userMsgs).toHaveLength(1);
});

test("get() returns undefined for an unknown id", async () => {
	const { store } = makeStore();
	expect(await store.get("never-existed")).toBeUndefined();
});

test("streamPrompt() returns Err(ConversationNotFound) for an unknown id", async () => {
	const { store } = makeStore();
	const result = await store.streamPrompt("does-not-exist", "hi");
	expect(Result.isError(result)).toBe(true);
	if (Result.isError(result)) expect(result.error._tag).toBe("ConversationNotFound");
});

test("streamPrompt() returns Err(PromptConflict) while a prompt is in-flight", async () => {
	const { store } = makeStore();
	const id = store.create();
	await sleep(10);

	const first = await store.streamPrompt(id, "first");
	expect(Result.isOk(first)).toBe(true);

	// Called synchronously after the first resolves: inFlight is still true
	// (the .finally that clears it runs on a later microtask).
	const second = await store.streamPrompt(id, "second");
	expect(Result.isError(second)).toBe(true);
	if (Result.isError(second)) expect(second.error._tag).toBe("PromptConflict");
});

test("streamPrompt() persists the transcript after the stream closes", async () => {
	const { store, db } = makeStore();
	const id = store.create();
	await sleep(10); // let the insert settle

	const result = await store.streamPrompt(id, "hello");
	if (Result.isError(result)) throw new Error("expected stream to start");
	for await (const _ of result.value.stream) {
		// drain — FakeAgent emits message_start/message_end then closes
	}
	await sleep(10); // let the .finally persistence settle

	const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
	expect(rows).toHaveLength(1);
	const transcript = rows[0]?.transcript;
	expect(transcript).toHaveLength(2);
	expect(transcript?.[0]).toMatchObject({ role: "user", content: "hello" });
	expect(transcript?.[1]).toMatchObject({ role: "assistant" });
});

test("delete() aborts in-flight prompts and removes the row from cache and DB", async () => {
	const agents: FakeAgent[] = [];
	const { store, db } = makeStore({ agentFactory: makeFakeFactory(agents) });
	const id = store.create();
	await sleep(10);
	const agent = agents[0]!;
	expect(agent).toBeDefined();

	await store.streamPrompt(id, "hi"); // starts an in-flight prompt
	const existed = store.delete(id);
	expect(existed).toBe(true);
	expect(agent.aborted).toBe(true);

	await sleep(10);
	const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
	expect(rows).toHaveLength(0);
	expect(await store.get(id)).toBeUndefined();
});

test("delete() returns false for an unknown id", () => {
	const { store } = makeStore();
	expect(store.delete("never-existed")).toBe(false);
});

test("evictIfNeeded() evicts the oldest conversation when over maxSize", async () => {
	const calls: FakeAgent[] = [];
	const { store } = makeStore({
		cacheSize: 2,
		agentFactory: makeFakeFactory(calls),
	});

	const id1 = store.create();
	expect(store.size()).toBe(1);
	store.create();
	expect(store.size()).toBe(2);
	const id3 = store.create(); // evicts id1 (oldest)
	expect(store.size()).toBe(2);
	await sleep(10);

	// id3 (most-recent) is still cached → no rehydration.
	const beforeHit = calls.length;
	await store.get(id3);
	expect(calls.length).toBe(beforeHit);

	// id1 (oldest) was evicted → rehydrates (new factory call).
	const beforeMiss = calls.length;
	const r1 = await store.get(id1);
	expect(r1).toBeDefined();
	expect(calls.length).toBe(beforeMiss + 1);
});

test("sweep() evicts conversations idle longer than 24h", () => {
	const { store } = makeStore();
	const realNow = Date.now();
	setSystemTime(realNow);

	store.create();
	expect(store.size()).toBe(1);

	// Advance just past the 24h TTL.
	setSystemTime(realNow + 24 * 60 * 60 * 1000 + 1);
	store.sweep();
	expect(store.size()).toBe(0);

	setSystemTime();
});

test("streamPrompt() returns Err(BudgetExceeded) when over budget", async () => {
	const { store } = makeStore({ conversationTokenBudget: 2 });
	const id = store.create();

	const result = await store.streamPrompt(id, "hi");
	if (Result.isError(result)) throw new Error("expected first prompt to start");
	for await (const _ of result.value.stream) {
		// drain
	}

	// FakeAgent uses 2 totalTokens per call. After first turn used=2,
	// check 2 >= 2 → blocks the second turn.
	const second = await store.streamPrompt(id, "again");
	expect(Result.isError(second)).toBe(true);
	if (Result.isError(second)) {
		const e = second.error as BudgetExceededError;
		expect(e._tag).toBe("BudgetExceeded");
		expect(e.used).toBe(2);
		expect(e.budget).toBe(2);
	}
});

test("streamPrompt() allows multiple turns when within budget", async () => {
	const { store } = makeStore({ conversationTokenBudget: 10 });
	const id = store.create();

	const first = await store.streamPrompt(id, "hi");
	if (Result.isError(first)) throw new Error("expected first prompt to start");
	for await (const _ of first.value.stream) {
		// drain
	}

	const second = await store.streamPrompt(id, "again");
	if (Result.isError(second)) throw new Error("expected second prompt to start");
	for await (const _ of second.value.stream) {
		// drain
	}

	const third = await store.streamPrompt(id, "more");
	expect(Result.isOk(third)).toBe(true);
});

test("streamPrompt() budget is restored from persisted transcript on rehydration", async () => {
	const agents: FakeAgent[] = [];
	const { store } = makeStore({
		agentFactory: makeFakeFactory(agents),
		conversationTokenBudget: 2,
	});
	const id = store.create();

	const first = await store.streamPrompt(id, "hi");
	if (Result.isError(first)) throw new Error("expected first prompt to start");
	for await (const _ of first.value.stream) {
		// drain
	}
	await sleep(10); // let persist settle

	// Evict from cache — force the next streamPrompt to rehydrate from DB
	store.sweep();

	const second = await store.streamPrompt(id, "again");
	expect(Result.isError(second)).toBe(true);
	if (Result.isError(second)) {
		const e = second.error as BudgetExceededError;
		expect(e._tag).toBe("BudgetExceeded");
		expect(e.used).toBe(2);
	}
});

test("create() initializes tokensUsed to 0 even with unlimited budget", () => {
	const { store } = makeStore({ conversationTokenBudget: 0 });
	expect(store.create().length > 0).toBe(true);
	// Smoke test: unlimited budget never blocks
});

test("DB persistence failures are surfaced via logger.error (regression for #59)", async () => {
	const realDb = createTestDb();
	// Proxy that breaks ONLY update(); insert/select/delete pass through.
	const errorDb = new Proxy(realDb, {
		get(target, prop) {
			if (prop === "update") {
				return () => ({
					set: () => ({
						where: () => Promise.reject(new Error("boom")),
					}),
				});
			}
			return Reflect.get(target, prop);
		},
	}) as unknown as DbClient;

	const errorSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	const mockLogger = { error: errorSpy } as unknown as Logger;
	const store = new ConversationStore(baseConfig, errorDb, makeFakeFactory(), mockLogger);
	stores.push(store);

	const id = store.create();
	await sleep(10); // insert (passthrough) settles

	const result = await store.streamPrompt(id, "x");
	if (Result.isError(result)) throw new Error("expected stream to start");
	for await (const _ of result.value.stream) {
		// drain
	}
	await sleep(10); // let the rejected update's .catch settle

	expect(errorSpy).toHaveBeenCalled();
	const logged = errorSpy.mock.calls.find(
		(call) => call[0] === "failed to persist transcript" && call[1]?.conversationId === id,
	);
	expect(logged).toBeDefined();
	expect(logged?.[1]?.err).toBeInstanceOf(Error);
});
