/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { OverpassBusyError } from "@pixies/core";
import { type Logger } from "@pixies/core/logging";
import { ConversationStore } from "./conversations.ts";
import { pipeAgentStream } from "./index.ts";

/**
 * End-to-end coverage for the `pipeAgentStream` catch block (issue #109).
 *
 * Every other error-flow layer (TaggedError messages, ErrorData schema,
 * matchError routing) already has tests; this file asserts the actual SSE
 * wire bytes that `pipeAgentStream` emits when the agent stream rejects:
 *
 *  - TaggedError → `error` event with `{message, errorTag, details}`
 *  - plain Error → `error` event with `{message}` only (byte-identical to
 *    the pre-#109 wire format — the back-compat invariant).
 *
 * The stream is driven directly (not through `ConversationStore.streamPrompt`)
 * so the test isolates the SSE-emission layer. `pipeAgentStream` only touches
 * `store.abort(id)` on client disconnect, which these tests never trigger, so
 * a no-op stub satisfies the contract without pulling in a real store + db.
 */

/** SSE frame as serialized by `SseWriter.write` (`event: <e>\ndata: <json>\n\n`). */
interface SseFrame {
	event: string;
	data: unknown;
}

/**
 * Parse the raw SSE wire text back into frames. Heartbeat frames (`: ping`)
 * are dropped — they don't start with `event:`.
 */
function parseSseFrames(text: string): SseFrame[] {
	return text
		.split("\n\n")
		.map((frame) => frame.trim())
		.filter((frame) => frame.startsWith("event:"))
		.map((frame) => {
			const eventMatch = frame.match(/^event: (.+)$/m);
			const dataMatch = frame.match(/^data: (.+)$/m);
			return {
				event: eventMatch?.[1] ?? "",
				data: dataMatch ? JSON.parse(dataMatch[1]!) : undefined,
			};
		});
}

/** A `ReadableStream<AgentEvent>` that rejects synchronously on start. */
function rejectingStream(err: unknown): ReadableStream<AgentEvent> {
	return new ReadableStream<AgentEvent>({
		start: (controller) => {
			controller.error(err);
		},
	});
}

/** Minimal ConversationStore stub — only `abort` is on the call path. */
function stubStore(): ConversationStore {
	return { abort: () => {} } as unknown as ConversationStore;
}

/** Mock logger that captures `error` calls (mirrors conversations.test.ts). */
function mockLogger() {
	const errorSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	return { logger: { error: errorSpy } as unknown as Logger, errorSpy };
}

test("pipeAgentStream emits errorTag + details when the stream rejects with a TaggedError (#109)", async () => {
	const { logger, errorSpy } = mockLogger();
	const err = new OverpassBusyError({ status: 429 });
	const response = pipeAgentStream(stubStore(), { stream: rejectingStream(err) }, "conv-1", logger);

	const text = await response.text();
	const frames = parseSseFrames(text);
	const errorFrame = frames.find((f) => f.event === "error");
	expect(errorFrame).toBeDefined();

	const data = errorFrame!.data as Record<string, unknown>;
	expect(data.message).toBe("Overpass: OSM server busy (HTTP 429)");
	expect(data.errorTag).toBe("OverpassBusy");
	expect(data.details).toMatchObject({ _tag: "OverpassBusy", status: 429 });

	// The catch block must also log the rejection (regression for the log line).
	expect(errorSpy).toHaveBeenCalled();
	const logged = errorSpy.mock.calls.find(
		(call) => call[0] === "agent stream error" && call[1]?.conversationId === "conv-1",
	);
	expect(logged).toBeDefined();
	expect(logged?.[1]?.err).toBe(err);
});

test("pipeAgentStream emits ONLY message when the stream rejects with a plain Error (byte-identical back-compat, #109)", async () => {
	const { logger } = mockLogger();
	const response = pipeAgentStream(
		stubStore(),
		{ stream: rejectingStream(new Error("something went wrong")) },
		"conv-2",
		logger,
	);

	const text = await response.text();
	const frames = parseSseFrames(text);
	const errorFrame = frames.find((f) => f.event === "error");
	expect(errorFrame).toBeDefined();

	const data = errorFrame!.data as Record<string, unknown>;
	expect(data.message).toBe("something went wrong");
	expect(Object.prototype.hasOwnProperty.call(data, "errorTag")).toBe(false);
	expect(Object.prototype.hasOwnProperty.call(data, "details")).toBe(false);
	// Byte-identical back-compat invariant: no additive fields sneak in.
	expect(Object.keys(data).sort()).toEqual(["message"]);
});
