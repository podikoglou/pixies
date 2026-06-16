/// <reference types="bun" />
import { afterEach, expect, mock, test } from "bun:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversations as conversationsTable, type DbClient } from "@pixies/core/db";
import { type Logger, silentLogger } from "@pixies/core/logging";
import { type ResolvedPixiesConfig } from "@pixies/core";
import { ConversationStore } from "./conversations.ts";
import { pipeAgentStream, withRequestLogging } from "./index.ts";

const testConfig: ResolvedPixiesConfig = {
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
	nominatimConcurrency: 1,
	nominatimIntervalCap: 1,
	nominatimIntervalMs: 1100,
	overpassConcurrency: 2,
	overpassIntervalCap: 2,
	overpassIntervalMs: 1000,
};

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

const noopAgentFactory = () =>
	({ state: { messages: [] }, subscribe: () => () => {}, abort() {} }) as unknown as Agent;

const stores: ConversationStore[] = [];

function makeStore(db?: DbClient): ConversationStore {
	const actualDb = db ?? createTestDb();
	const store = new ConversationStore(testConfig, actualDb, noopAgentFactory, silentLogger);
	stores.push(store);
	return store;
}

afterEach(() => {
	while (stores.length) stores.pop()?.stop();
});

// Task 1: pipeAgentStream logs errors to logger.error
test("pipeAgentStream logs error when stream throws", async () => {
	const errorSpy = mock((_obj: unknown, _msg?: string) => {});
	const mockLogger = { error: errorSpy } as unknown as Logger;

	const store = makeStore();
	const conversationId = store.create();

	const failingStream = new ReadableStream<AgentEvent>({
		start(controller) {
			controller.error(new Error("LLM API timeout"));
		},
	});

	const result = { ok: true as const, stream: failingStream };
	pipeAgentStream(store, result, conversationId, mockLogger);

	await Bun.sleep(50);

	expect(errorSpy).toHaveBeenCalled();
	const call = errorSpy.mock.calls.find((c) => c[1] === "agent stream error");
	expect(call).toBeDefined();
	expect(call![0]).toMatchObject({ conversationId });
	expect((call![0] as Record<string, unknown>).err).toBeInstanceOf(Error);
});

// Task 1: pipeAgentStream does not call logger.error on successful stream
test("pipeAgentStream does not log error on successful stream", async () => {
	const errorSpy = mock((_obj: unknown, _msg?: string) => {});
	const mockLogger = { error: errorSpy } as unknown as Logger;

	const store = makeStore();
	const conversationId = store.create();

	const successStream = new ReadableStream<AgentEvent>({
		start(controller) {
			controller.close();
		},
	});

	const result = { ok: true as const, stream: successStream };
	pipeAgentStream(store, result, conversationId, mockLogger);

	await Bun.sleep(50);

	expect(errorSpy).not.toHaveBeenCalled();
});

// Task 2: withRequestLogging logs structured request fields
test("withRequestLogging logs method, path, statusCode, durationMs and no sensitive fields", async () => {
	const infoSpy = mock((_obj: unknown, _msg?: string) => {});
	const mockLogger = { info: infoSpy } as unknown as Logger;

	const handler = withRequestLogging(mockLogger, (_req: any, _server: any) => {
		return new Response("ok", { status: 200 });
	});

	const req = new Request("http://localhost:3000/health", {
		method: "GET",
		headers: { authorization: "Bearer secret-token", cookie: "session=abc" },
	});

	await handler(req, {} as any);

	expect(infoSpy).toHaveBeenCalledTimes(1);
	const [fields, msg] = infoSpy.mock.calls[0]!;
	expect(msg).toBe("request");
	expect(fields).toMatchObject({
		method: "GET",
		path: "/health",
		statusCode: 200,
		durationMs: expect.any(Number),
	});

	const obj = fields as Record<string, unknown>;
	expect(obj.body).toBeUndefined();
	expect(obj.headers).toBeUndefined();
	expect(obj.cookie).toBeUndefined();
	expect(obj.query).toBeUndefined();
	expect(obj.authorization).toBeUndefined();
});
