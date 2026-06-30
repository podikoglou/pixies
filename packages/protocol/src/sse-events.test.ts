/// <reference types="bun" />
import { test, expect } from "bun:test";
import { Value } from "typebox/value";
import { toClientAssistantMessage, AssistantMessageSchema, ErrorData } from "./sse-events.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Build a realistic pi-ai shaped AssistantMessage with all internal metadata. */
function makePiAiAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello", textSignature: "sig-text" },
			{
				type: "toolCall",
				id: "call_1",
				name: "geocode",
				arguments: { q: "Berlin" },
				thoughtSignature: "sig-thought",
			},
			{
				type: "thinking",
				thinking: "reasoning",
				thinkingSignature: "sig-thinking",
				redacted: false,
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3.5",
		responseModel: "claude-3.5-sonnet",
		responseId: "resp_abc",
		diagnostics: [{ type: "latency", timestamp: 1_700_000_000, details: { ms: 12 } }],
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		},
		stopReason: "stop",
		errorMessage: undefined,
		timestamp: 1_700_000_000,
	};
}

test("toClientAssistantMessage strips all top-level metadata", () => {
	const out = toClientAssistantMessage(makePiAiAssistantMessage());
	expect(Object.keys(out).sort()).toEqual(["content", "role", "stopReason"].sort());
	expect(out.role).toBe("assistant");
	expect(out.stopReason).toBe("stop");
	for (const key of [
		"api",
		"provider",
		"model",
		"responseModel",
		"responseId",
		"diagnostics",
		"usage",
		"errorMessage",
		"timestamp",
	]) {
		expect(out).not.toHaveProperty(key);
	}
});

test("toClientAssistantMessage keeps text blocks and strips nested extras", () => {
	const out = toClientAssistantMessage(makePiAiAssistantMessage());
	// Unknown/non-text content blocks collapse to { type } only (per UnknownContentBlock).
	// Text block keeps text, drops textSignature.
	const text = out.content.find((b) => b.type === "text");
	expect(text).toEqual({ type: "text", text: "Hello" });
	// toolCall / thinking blocks: only `type` survives (they fall into UnknownContentBlock).
	const toolCall = out.content.find((b) => b.type === "toolCall");
	expect(toolCall).toEqual({ type: "toolCall" });
	const thinking = out.content.find((b) => b.type === "thinking");
	expect(thinking).toEqual({ type: "thinking" });
});

test("toClientAssistantMessage does NOT mutate the input", () => {
	const msg = makePiAiAssistantMessage();
	const snapshot = JSON.parse(JSON.stringify(msg));
	toClientAssistantMessage(msg);
	expect(msg).toEqual(snapshot);
	expect(msg.api).toBe("anthropic-messages");
	expect(msg.usage.totalTokens).toBe(30);
	expect(msg.timestamp).toBe(1_700_000_000);
	expect(msg.content[0]).toHaveProperty("textSignature", "sig-text");
	expect(msg.content[1]).toHaveProperty("arguments");
});

test("toClientAssistantMessage passes through empty content array", () => {
	const msg: AssistantMessage = {
		...makePiAiAssistantMessage(),
		content: [],
	};
	const out = toClientAssistantMessage(msg);
	expect(out.content).toEqual([]);
});

test("toClientAssistantMessage output satisfies the strict AssistantMessageSchema", () => {
	const out = toClientAssistantMessage(makePiAiAssistantMessage());
	expect(Value.Check(AssistantMessageSchema, out)).toBe(true);
});

// --- ErrorData backward-compatibility ---------------------------
// The `errorTag` / `details` fields are additive; legacy { message }-only
// payloads must still validate so old clients keep working.

test("ErrorData accepts a legacy { message } payload (back-compat)", () => {
	expect(Value.Check(ErrorData, { message: "boom" })).toBe(true);
});

test("ErrorData accepts the enriched { message, errorTag, details } payload", () => {
	expect(
		Value.Check(ErrorData, { message: "boom", errorTag: "OverpassBusy", details: { status: 429 } }),
	).toBe(true);
});
