/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Value } from "typebox/value";
import {
	isPersistedTranscript,
	toClientTranscriptMessage,
	TranscriptMessageSchema,
} from "./transcript-schema.ts";
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

const METADATA_KEYS = [
	"api",
	"provider",
	"model",
	"responseModel",
	"responseId",
	"usage",
	"diagnostics",
	"errorMessage",
	"timestamp",
];

test("toClientTranscriptMessage strips all metadata from assistant message", () => {
	const out = toClientTranscriptMessage(makeAssistant());
	expect(out.role).toBe("assistant");
	for (const key of METADATA_KEYS) {
		expect(out).not.toHaveProperty(key);
	}
	expect(out.content).toEqual([{ type: "text", text: "Hi" }]);
});

test("toClientTranscriptMessage strips timestamp from user message", () => {
	const out = toClientTranscriptMessage(makeUser());
	if (out.role !== "user") throw new Error("expected user role");
	expect(out.content).toBe("where is berlin");
	expect(out).not.toHaveProperty("timestamp");
});

test("toClientTranscriptMessage strips timestamp from toolResult message", () => {
	const out = toClientTranscriptMessage(makeToolResult());
	if (out.role !== "toolResult") throw new Error("expected toolResult role");
	expect(out.toolCallId).toBe("call_1");
	expect(out.toolName).toBe("geocode");
	expect(out.content).toEqual([{ type: "text", text: "Berlin (52.5,13.4)" }]);
	expect(out.details).toEqual({ data: [{ placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" }] });
	expect(out.isError).toBe(false);
	expect(out).not.toHaveProperty("timestamp");
});

test("toClientTranscriptMessage does NOT mutate the input (assistant)", () => {
	const msg = makeAssistant();
	const snapshot = JSON.parse(JSON.stringify(msg));
	toClientTranscriptMessage(msg);
	expect(msg).toEqual(snapshot);
	expect(msg.usage.totalTokens).toBe(3);
	expect(msg.timestamp).toBe(1_700_000_000);
});

test("toClientTranscriptMessage does NOT mutate the input (user)", () => {
	const msg = makeUser();
	toClientTranscriptMessage(msg);
	expect(msg.timestamp).toBe(1_700_000_000);
});

test("toClientTranscriptMessage does NOT mutate the input (toolResult)", () => {
	const msg = makeToolResult();
	const detailsRef = msg.details;
	toClientTranscriptMessage(msg);
	expect(msg.timestamp).toBe(1_700_000_000);
	expect(msg.details).toBe(detailsRef);
});

test("toClientTranscriptMessage output satisfies the strict TranscriptMessageSchema", () => {
	for (const msg of [makeAssistant(), makeUser(), makeToolResult()]) {
		const out = toClientTranscriptMessage(msg);
		expect(Value.Check(TranscriptMessageSchema, out)).toBe(true);
	}
});

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
