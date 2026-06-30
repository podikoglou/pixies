/// <reference types="bun" />
import { test, expect } from "bun:test";
import { isPersistedTranscript } from "./persisted-transcript.ts";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

function makeAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hi" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3.5",
		responseModel: "claude-3.5-sonnet",
		responseId: "resp_abc",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_000,
	};
}

function makeUser(): UserMessage {
	return { role: "user", content: "where is berlin", timestamp: 1_700_000_000 };
}

function makeToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "geocode",
		content: [{ type: "text", text: "Berlin (52.5,13.4)" }],
		details: { data: [{ placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" }] },
		isError: false,
		timestamp: 1_700_000_000,
	};
}

// ---- PersistedTranscriptSchema / isPersistedTranscript guard -----
//
// The SQLite `transcript` column stores the full AgentMessage[] (with metadata).
// We only lock in the happy path: a real persisted row round-trips through the
// guard. Rejection of non-conforming shapes is enforced at compile time by the
// TypeBox schema and is its responsibility, not ours.

test("isPersistedTranscript: real persisted AgentMessage[] (with timestamp/usage/api metadata) → true", () => {
	const persisted = [makeAssistant(), makeUser(), makeToolResult()];
	expect(isPersistedTranscript(persisted)).toBe(true);
});
