/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { OverpassBusyError } from "@pixies/core";
import { type Logger } from "@pixies/core/logging";
import { ConversationStore } from "./conversations.ts";
import { pipeAgentStream } from "./index.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/**
 * End-to-end coverage for the `pipeAgentStream` catch block.
 *
 * Every other error-flow layer (TaggedError messages, ErrorData schema,
 * matchError routing) already has tests; this file asserts the actual SSE
 * wire bytes that `pipeAgentStream` emits when the agent stream rejects:
 *
 *  - TaggedError → `error` event with `{message, errorTag, details}`
 *  - plain Error → `error` event with `{message}` only (byte-identical to
 *    the prior wire format — the back-compat invariant).
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

/**
 * A `ReadableStream<AgentEvent>` that enqueues `events` then NEVER closes, so
 * the test can cancel the SSE response mid-flight. `end()` closes
 * the underlying controller so the dangling consumer loop can settle for test
 * teardown — otherwise the never-ending stream would keep a promise pending.
 */
function hangingStream(events: AgentEvent[]): {
	stream: ReadableStream<AgentEvent>;
	end: () => void;
} {
	let controller!: ReadableStreamDefaultController<AgentEvent>;
	const stream = new ReadableStream<AgentEvent>({
		start(c) {
			controller = c;
			for (const e of events) c.enqueue(e);
		},
	});
	return {
		stream,
		end: () => {
			try {
				controller.close();
			} catch {
				// already closed
			}
		},
	};
}

/** A `ReadableStream<AgentEvent>` that enqueues `events` then closes on start. */
function closingStream(events: AgentEvent[] = []): ReadableStream<AgentEvent> {
	return new ReadableStream<AgentEvent>({
		start(c) {
			for (const e of events) c.enqueue(e);
			c.close();
		},
	});
}

/**
 * Minimal `AgentEvent` stubs. The TTFT discriminant reads only `event.type`
 * and `event.assistantMessageEvent.type`; `translateAgentEvent` reads only the
 * tool-event fields it forwards. So these mirror the real pi-agent-core shapes
 * (`packages/server/src/events.ts`) at the granularity the loop touches.
 */
const textDeltaEvent = (): AgentEvent =>
	({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta" },
	}) as unknown as AgentEvent;
const toolStartEvent = (): AgentEvent =>
	({
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "query_osm",
		args: {},
	}) as unknown as AgentEvent;

/** stubStore variant whose `abort` is a spy, so disconnect forwarding is assertable. */
function stubStoreWithSpy(): { store: ConversationStore; abortSpy: ReturnType<typeof mock> } {
	const abortSpy = mock((_id: string) => {});
	return { store: { abort: abortSpy } as unknown as ConversationStore, abortSpy };
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

interface Captured {
	distinctId: string;
	event: string;
	properties: Record<string, unknown>;
}

/** Spy analytics client that records captures without touching the network. */
function spyPostHog(): PostHogAnalyticsClient & { captures: Captured[] } {
	const captures: Captured[] = [];
	return {
		captures,
		capture: (m) => captures.push({ ...m, properties: { ...m.properties } }),
		shutdown: async () => {},
	};
}

test("pipeAgentStream emits errorTag + details when the stream rejects with a TaggedError", async () => {
	const { logger, errorSpy } = mockLogger();
	const posthog = spyPostHog();
	const err = new OverpassBusyError({ status: 429 });
	const response = pipeAgentStream(
		stubStore(),
		{ stream: rejectingStream(err) },
		"conv-1",
		logger,
		posthog,
	);

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

	// Privacy pin: the analytics capture ships the error TAG ONLY — never
	// err.message/details, which embed the OSM body and the searched place name.
	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]).toMatchObject({
		distinctId: "conv-1",
		event: "agent stream error",
	});
	expect(posthog.captures[0]?.properties).toEqual({
		$process_person_profile: false,
		error_tag: "OverpassBusy",
	});
});

test("pipeAgentStream emits ONLY message when the stream rejects with a plain Error (byte-identical back-compat)", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const response = pipeAgentStream(
		stubStore(),
		{ stream: rejectingStream(new Error("something went wrong")) },
		"conv-2",
		logger,
		posthog,
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

	// Privacy pin: even with no tag, nothing beyond the (suppressed)
	// $process_person_profile flag is captured — no message/details/error keys.
	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]?.properties).toEqual({ $process_person_profile: false });
});

test("pipeAgentStream captures `agent stream disconnect` (had_output=true) when the client cancels mid-flight after a tool event", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const { store, abortSpy } = stubStoreWithSpy();
	const { stream, end } = hangingStream([
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "query_osm", args: {} },
	]);
	const response = pipeAgentStream(store, { stream }, "conv-1", logger, posthog);

	// Read the tool_execution_start frame off the wire — this self-synchronises:
	// the read resolves only after the loop set `firstOutputAt` and wrote the
	// frame, so `had_output` is deterministically true at cancel time.
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let sawTool = false;
	while (!sawTool) {
		const { value, done } = await reader.read();
		if (done) break;
		if (parseSseFrames(decoder.decode(value)).some((f) => f.event === "tool_execution_start"))
			sawTool = true;
	}
	// Cancelling the response body is the disconnect path → fires onClose.
	await reader.cancel();
	// Close the never-ending agent stream so the dangling consumer settles.
	end();

	expect(sawTool).toBe(true);
	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]).toMatchObject({
		distinctId: "conv-1",
		event: "agent stream disconnect",
	});
	const props = posthog.captures[0]?.properties as Record<string, unknown>;
	expect(props.$process_person_profile).toBe(false);
	expect(typeof props.elapsed_ms).toBe("number");
	expect(props.had_output).toBe(true);
	expect(abortSpy).toHaveBeenCalledWith("conv-1");
});

test("pipeAgentStream captures `agent stream disconnect` with had_output=false when cancelled before any tool event", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const { store, abortSpy } = stubStoreWithSpy();
	// No event is ever enqueued → the stream produces no frames, so we cancel
	// immediately (reading would hang forever on the empty stream).
	const { stream, end } = hangingStream([]);
	const response = pipeAgentStream(store, { stream }, "conv-2", logger, posthog);

	await response.body?.cancel();
	end();

	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]).toMatchObject({
		distinctId: "conv-2",
		event: "agent stream disconnect",
	});
	const props = posthog.captures[0]?.properties as Record<string, unknown>;
	expect(props.had_output).toBe(false);
	expect(typeof props.elapsed_ms).toBe("number");
	expect(abortSpy).toHaveBeenCalledWith("conv-2");
});

test("pipeAgentStream does NOT capture disconnect when the stream completes normally (lifecycle guard)", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const { store } = stubStoreWithSpy();
	const response = pipeAgentStream(store, { stream: closingStream() }, "conv-3", logger, posthog);

	// Drain the full body: the loop writes `done`, then the finally block sets
	// `state = "completed"` and closes — no client cancel, so no disconnect event.
	// (`agent stream done` DOES fire here, so assert by event name.)
	await response.text();

	expect(posthog.captures.filter((c) => c.event === "agent stream disconnect")).toHaveLength(0);
});

test("pipeAgentStream captures `agent stream first token` (once) + `agent stream done` for a normal stream", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	// tool_start, then TWO text_deltas — pins that first-token fires exactly once.
	const response = pipeAgentStream(
		stubStore(),
		{ stream: closingStream([toolStartEvent(), textDeltaEvent(), textDeltaEvent()]) },
		"conv-1",
		logger,
		posthog,
	);

	const text = await response.text();
	const frames = parseSseFrames(text);

	// `agent stream first token` fires mid-stream at the first text_delta.
	const firstToken = posthog.captures.filter((c) => c.event === "agent stream first token");
	expect(firstToken).toHaveLength(1); // the `firstTokenMs === undefined` guard pins this to 1.
	const ttftProps = firstToken[0]!.properties;
	expect(ttftProps.$process_person_profile).toBe(false);
	expect(Number.isInteger(ttftProps.ttft_ms)).toBe(true);
	// Non-negative, not strictly positive: the stub stream is consumed within a
	// tight microtask, so sub-ms (0) is legitimately possible here.
	expect(ttftProps.ttft_ms as number).toBeGreaterThanOrEqual(0);

	// `agent stream done` fires once at the terminal done frame (stream completed).
	const done = posthog.captures.filter((c) => c.event === "agent stream done");
	expect(done).toHaveLength(1);
	const doneProps = done[0]!.properties;
	expect(doneProps.$process_person_profile).toBe(false);
	expect(Number.isInteger(doneProps.duration_ms)).toBe(true);
	expect(doneProps.duration_ms as number).toBeGreaterThanOrEqual(0);
	// ttft_ms is reused (not recomputed) and never exceeds the total duration.
	expect(doneProps.ttft_ms).toBe(ttftProps.ttft_ms);
	expect((doneProps.duration_ms as number) >= (ttftProps.ttft_ms as number)).toBe(true);

	// Back-compat invariant: the `done` SSE frame carries byte-identical
	// `durationMs` (no `ttftMs` added to the wire contract).
	const doneFrame = frames.find((f) => f.event === "done");
	expect(doneFrame).toBeDefined();
	expect((doneFrame!.data as Record<string, unknown>).durationMs).toBe(doneProps.duration_ms);
	expect(Object.prototype.hasOwnProperty.call(doneFrame!.data, "ttftMs")).toBe(false);
});

test("pipeAgentStream omits `agent stream first token` and done `ttft_ms` when no text token is emitted", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	// Only tool events — no text_delta → no TTFT measurement possible.
	const response = pipeAgentStream(
		stubStore(),
		{ stream: closingStream([toolStartEvent(), toolStartEvent()]) },
		"conv-2",
		logger,
		posthog,
	);

	await response.text();

	expect(posthog.captures.filter((c) => c.event === "agent stream first token")).toHaveLength(0);

	const done = posthog.captures.filter((c) => c.event === "agent stream done");
	expect(done).toHaveLength(1);
	const doneProps = done[0]!.properties;
	expect(Number.isInteger(doneProps.duration_ms)).toBe(true);
	// No first token → ttft_ms key absent (not 0, not undefined-as-value: absent).
	expect(Object.prototype.hasOwnProperty.call(doneProps, "ttft_ms")).toBe(false);
});

test("pipeAgentStream does NOT capture `agent stream done` for an aborted stream, but first token still fires (abort guard)", async () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const { store, abortSpy } = stubStoreWithSpy();
	// text_delta fires the first-token capture; tool_start gives a wire frame to
	// self-sync on (assistant text is suppressed, so text_delta emits no frame).
	const { stream, end } = hangingStream([textDeltaEvent(), toolStartEvent()]);
	const response = pipeAgentStream(store, { stream }, "conv-3", logger, posthog);

	// Read until the tool_execution_start frame — by then the loop has consumed
	// the text_delta (firing the first-token capture) and the tool event.
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let sawTool = false;
	while (!sawTool) {
		const { value, done: rdDone } = await reader.read();
		if (rdDone) break;
		if (parseSseFrames(decoder.decode(value)).some((f) => f.event === "tool_execution_start"))
			sawTool = true;
	}
	// Cancelling the response body is the disconnect path → fires onClose,
	// which transitions state to "aborted" and forwards to `store.abort`.
	await reader.cancel();
	// Close the never-ending agent stream so the dangling consumer settles.
	end();
	// Let the IIFE drain its remaining microtasks (loop exit + no-op done write).
	await new Promise((r) => setTimeout(r, 0));

	expect(sawTool).toBe(true);
	// First token fired mid-stream BEFORE the cancel — survives the abort
	// (that is exactly why TTFT is captured mid-stream, not at `done`).
	expect(posthog.captures.filter((c) => c.event === "agent stream first token")).toHaveLength(1);
	// The done capture is guarded out — an abort must never count as a fast
	// completion (the `state === "running"` guard).
	expect(posthog.captures.filter((c) => c.event === "agent stream done")).toHaveLength(0);
	expect(abortSpy).toHaveBeenCalledWith("conv-3");
});
