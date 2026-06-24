/// <reference types="bun" />
import { test, expect } from "bun:test";
import { chatReducer, initialChatState } from "./chat-reducer.ts";

test("STREAM_DONE with responseTimeMs attaches to last item", () => {
	const state = {
		...initialChatState,
		isStreaming: true,
		items: [
			{ kind: "user-message" as const, text: "hello" },
			{
				kind: "tool-call" as const,
				toolCallId: "tc-1",
				toolName: "query_osm",
				args: { q: "cafe" },
				status: "done" as const,
				queued: false,
				resultText: "3 results",
				result: { kind: "query_osm" as const, entries: [], count: 3 },
			},
		],
	};

	const next = chatReducer(state, { type: "STREAM_DONE", responseTimeMs: 1234 });

	expect(next.isStreaming).toBe(false);
	expect(next.items).toHaveLength(2);
	expect(next.items[0]!.responseTimeMs).toBeUndefined();
	expect(next.items[1]!.responseTimeMs).toBe(1234);
});

test("STREAM_DONE with undefined responseTimeMs just stops streaming", () => {
	const state = {
		...initialChatState,
		isStreaming: true,
		items: [{ kind: "user-message" as const, text: "hello" }],
	};

	const next = chatReducer(state, { type: "STREAM_DONE" });

	expect(next.isStreaming).toBe(false);
	expect(next.items).toEqual(state.items);
});

test("STREAM_DONE with responseTimeMs but empty items does not crash", () => {
	const state = { ...initialChatState, isStreaming: true, items: [] };

	const next = chatReducer(state, { type: "STREAM_DONE", responseTimeMs: 5678 });

	expect(next.isStreaming).toBe(false);
	expect(next.items).toEqual([]);
});

test("STREAM_DONE with responseTimeMs attaches to user-message when no tool calls", () => {
	const state = {
		...initialChatState,
		isStreaming: true,
		items: [{ kind: "user-message" as const, text: "hello" }],
	};

	const next = chatReducer(state, { type: "STREAM_DONE", responseTimeMs: 999 });

	expect(next.isStreaming).toBe(false);
	expect(next.items).toHaveLength(1);
	expect(next.items[0]!.responseTimeMs).toBe(999);
});
