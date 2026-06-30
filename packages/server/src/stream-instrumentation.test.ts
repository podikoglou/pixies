/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OverpassBusyError } from "@pixies/core";
import { type Logger } from "@pixies/core/logging";
import { StreamInstrumentation } from "./stream-instrumentation.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/**
 * Direct unit coverage for the {@link StreamInstrumentation} seam. These
 * tests exercise timing + analytics in isolation, WITHOUT an SSE round-trip
 * (`pipe-agent-stream.test.ts` still pins the end-to-end wire + lifecycle).
 * The tag-only-on-error privacy property is asserted here directly, not just
 * indirectly through the wire bytes.
 */

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

/** Mock logger that captures `error` calls (mirrors pipe-agent-stream.test.ts). */
function mockLogger() {
	const errorSpy = mock((_msg?: string, _properties?: Record<string, unknown>) => {});
	return { logger: { error: errorSpy } as unknown as Logger, errorSpy };
}

test("recordFirstTextToken() fires `agent stream first token` exactly once (idempotent)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	// The loop calls this on every text_delta; only the first must capture.
	instr.recordFirstTextToken();
	instr.recordFirstTextToken();
	instr.recordFirstTextToken();

	const firstToken = posthog.captures.filter((c) => c.event === "agent stream first token");
	expect(firstToken).toHaveLength(1);
	expect(firstToken[0]).toMatchObject({ distinctId: "conv-1" });
	const props = firstToken[0]!.properties;
	expect(props.$process_person_profile).toBe(false);
	expect(Number.isInteger(props.ttft_ms)).toBe(true);
	// Non-negative, not strictly positive: sub-ms (0) is legitimately possible.
	expect(props.ttft_ms as number).toBeGreaterThanOrEqual(0);
});

test("complete() captures exactly one `agent stream done` with int duration_ms (no ttft_ms when no token fired)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	const durationMs = instr.complete();

	// Duration is computed once and returned for the byte-identical wire frame.
	expect(durationMs).toBeTypeOf("number");
	expect(Number.isInteger(durationMs)).toBe(true);
	expect((durationMs as number) >= 0).toBe(true);

	const done = posthog.captures.filter((c) => c.event === "agent stream done");
	expect(done).toHaveLength(1);
	const props = done[0]!.properties;
	expect(props.$process_person_profile).toBe(false);
	expect(Number.isInteger(props.duration_ms)).toBe(true);
	// The captured value IS the returned value — duration is not recomputed.
	expect(props.duration_ms).toBe(durationMs);
	// No first token → ttft_ms key absent (not 0, not undefined-as-value: absent).
	expect(Object.prototype.hasOwnProperty.call(props, "ttft_ms")).toBe(false);
});

test("complete() reuses the recorded ttft_ms (not recomputed) when a text token fired", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordFirstTextToken();
	const firstTokenMs = posthog.captures[0]!.properties.ttft_ms;
	const durationMs = instr.complete();

	const done = posthog.captures.filter((c) => c.event === "agent stream done");
	expect(done).toHaveLength(1);
	const props = done[0]!.properties;
	expect(props.ttft_ms).toBe(firstTokenMs); // reused verbatim
	expect(props.duration_ms).toBe(durationMs);
	// ttft_ms never exceeds the total duration (both measured from startTime).
	expect((props.duration_ms as number) >= (props.ttft_ms as number)).toBe(true);
});

test("complete() is idempotent — a second call returns undefined and captures nothing more", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	expect(instr.complete()).toBeTypeOf("number");
	expect(instr.complete()).toBeUndefined();

	expect(posthog.captures.filter((c) => c.event === "agent stream done")).toHaveLength(1);
});

test("disconnect() captures `agent stream disconnect` with had_output=false when no output was recorded", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.disconnect();

	const disconnect = posthog.captures.filter((c) => c.event === "agent stream disconnect");
	expect(disconnect).toHaveLength(1);
	expect(disconnect[0]).toMatchObject({ distinctId: "conv-1" });
	const props = disconnect[0]!.properties;
	expect(props.$process_person_profile).toBe(false);
	expect(Number.isInteger(props.elapsed_ms)).toBe(true);
	expect(props.had_output).toBe(false);
});

test("recordFirstOutput() flips a later disconnect's `had_output` to true (idempotent)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordFirstOutput();
	instr.recordFirstOutput(); // idempotent
	instr.disconnect();

	const props = posthog.captures.filter((c) => c.event === "agent stream disconnect")[0]!
		.properties;
	expect(props.had_output).toBe(true);
});

test("disconnect() is a no-op after complete() (a completed stream never emits disconnect)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.complete();
	instr.disconnect();

	expect(posthog.captures.filter((c) => c.event === "agent stream disconnect")).toHaveLength(0);
	expect(posthog.captures.filter((c) => c.event === "agent stream done")).toHaveLength(1);
});

test("an aborted stream's complete() does NOT emit `agent stream done`", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.disconnect(); // client gone → state = aborted
	const durationMs = instr.complete();

	expect(durationMs).toBeUndefined();
	expect(posthog.captures.filter((c) => c.event === "agent stream done")).toHaveLength(0);
	expect(posthog.captures.filter((c) => c.event === "agent stream disconnect")).toHaveLength(1);
});

test("first token still fires mid-stream when the stream is later aborted", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	// TTFT is captured mid-stream precisely so it survives a later abort —
	// measuring only at `done` would re-create the survivor-bias this is about.
	instr.recordFirstTextToken();
	instr.disconnect();

	expect(posthog.captures.filter((c) => c.event === "agent stream first token")).toHaveLength(1);
	expect(posthog.captures.filter((c) => c.event === "agent stream disconnect")).toHaveLength(1);
});

test("fail(TaggedError) captures `agent stream error` with the TAG ONLY — never message/details", () => {
	const { logger, errorSpy } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);
	const err = new OverpassBusyError({ status: 429 });

	const frame = instr.fail(err);

	// Wire ingredients returned for the byte-identical `error` SSE frame.
	expect(frame.tag).toBe("OverpassBusy");
	expect(frame.message).toBe("Overpass: OSM server busy (HTTP 429)");
	expect(frame.details).toMatchObject({ _tag: "OverpassBusy", status: 429 });

	// The catch block must also log the rejection (conversationId + err).
	const logged = errorSpy.mock.calls.find(
		(call) => call[0] === "agent stream error" && call[1]?.conversationId === "conv-1",
	);
	expect(logged).toBeDefined();
	expect(logged?.[1]?.err).toBe(err);

	// Privacy pin (direct): analytics ships EXACTLY the profile flag + the tag,
	// and nothing else. Overpass errors embed the OSM body + searched place name
	// in `.message`, which must never reach analytics.
	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]).toMatchObject({
		distinctId: "conv-1",
		event: "agent stream error",
	});
	expect(posthog.captures[0]?.properties).toEqual({
		$process_person_profile: false,
		error_tag: "OverpassBusy",
	});
	// Belt-and-braces: no message/details/error keys leaked into analytics.
	expect(Object.keys(posthog.captures[0]!.properties).sort()).toEqual(
		["$process_person_profile", "error_tag"].sort(),
	);
});

test("fail(plain Error) captures `agent stream error` with no properties beyond the profile flag", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-2", posthog, logger);

	const frame = instr.fail(new Error("boom"));

	// No tag on a plain Error → no errorTag/details in the wire ingredients.
	expect(frame.tag).toBeUndefined();
	expect(frame.details).toBeUndefined();
	expect(frame.message).toBe("boom");

	expect(posthog.captures).toHaveLength(1);
	expect(posthog.captures[0]?.properties).toEqual({ $process_person_profile: false });
});

test("fail() no-ops analytics when the client is undefined (off-switch), but still logs + returns the frame", () => {
	const { logger, errorSpy } = mockLogger();
	const instr = new StreamInstrumentation("conv-1", undefined, logger);

	const frame = instr.fail(new Error("boom"));

	expect(frame.message).toBe("boom");
	expect(errorSpy).toHaveBeenCalledTimes(1);
	// No client → no capture call site to assert against; the only guarantee is
	// it must not throw. (No spy to record; success is reaching this line.)
});

// ---- `agent turn` (recordTurnStart / recordTurnEnd) -----------------------

/**
 * Minimal `turn_end`-shape stubs. `recordTurnEnd` reads only `message.role`
 * (the assistant guard), `stopReason`, `usage`, and each result's `toolName` /
 * `isError` / `details` — so these mirror the real pi shapes at that
 * granularity. `as unknown as AgentMessage` matches the loop's own stub style.
 */
function assistantTurnMessage(
	opts: {
		stopReason?: string;
		input?: number;
		output?: number;
		cacheRead?: number;
		/** Omit cacheRead entirely (vs. reporting 0) to exercise the optional case. */
		noCacheRead?: boolean;
	} = {},
): AgentMessage {
	const usage: Record<string, unknown> = {
		input: opts.input ?? 100,
		output: opts.output ?? 50,
	};
	if (!opts.noCacheRead) usage.cacheRead = opts.cacheRead ?? 10;
	return {
		role: "assistant",
		stopReason: opts.stopReason ?? "toolUse",
		usage,
	} as unknown as AgentMessage;
}

/** One tool result (a `turn_end.toolResults[]` member). */
function turnToolResult(
	opts: {
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	} = {},
): { toolName: string; isError: boolean; details?: unknown } {
	return {
		toolName: opts.toolName ?? "execute_code",
		isError: opts.isError ?? false,
		...(opts.details !== undefined ? { details: opts.details } : {}),
	};
}

test("recordTurnEnd() captures exactly one `agent turn` with coarse-metadata-only properties", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnStart();
	instr.recordTurnEnd(assistantTurnMessage({ stopReason: "toolUse", input: 120, output: 7 }), [
		turnToolResult({ toolName: "execute_code" }),
		turnToolResult({ toolName: "execute_code" }),
	]);

	const turn = posthog.captures.filter((c) => c.event === "agent turn");
	expect(turn).toHaveLength(1);
	expect(turn[0]).toMatchObject({ distinctId: "conv-1" });
	// Privacy pin: every key is a count / id / enum / duration. Tool ARGUMENTS
	// never ship (tool names are ids; args live on tool_execution_start, which
	// this path never reads). `$process_person_profile: false` is injected
	// centrally by captureServerEvent.
	expect(turn[0]!.properties).toEqual({
		$process_person_profile: false,
		turn_index: 0,
		tool_calls: 2,
		tool_names: ["execute_code", "execute_code"],
		stop_reason: "toolUse",
		duration_ms: turn[0]!.properties.duration_ms,
		input_tokens: 120,
		output_tokens: 7,
		cache_read_tokens: 10,
		had_tool_error: false,
		had_busy_result: false,
	});
	expect(Number.isInteger(turn[0]!.properties.duration_ms)).toBe(true);
	expect(turn[0]!.properties.duration_ms as number).toBeGreaterThanOrEqual(0);
});

test("turn_index advances per turn (0-based), and duration_ms is measured from the preceding turn_start", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnEnd(assistantTurnMessage(), [turnToolResult()]); // turn 0 (no turn_start → stream start)
	instr.recordTurnStart();
	instr.recordTurnEnd(assistantTurnMessage(), [turnToolResult(), turnToolResult()]); // turn 1

	const turns = posthog.captures.filter((c) => c.event === "agent turn");
	expect(turns).toHaveLength(2);
	expect(turns[0]!.properties.turn_index).toBe(0);
	expect(turns[1]!.properties.turn_index).toBe(1);
	// The turn_start-anchored turn can't precede the stream-start-anchored one.
	expect((turns[1]!.properties.duration_ms as number) >= 0).toBe(true);
});

test("had_tool_error is true when any tool result in the turn failed", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnEnd(assistantTurnMessage(), [
		turnToolResult({ toolName: "execute_code" }),
		turnToolResult({ toolName: "execute_code", isError: true, details: { boom: true } }),
	]);

	const props = posthog.captures.filter((c) => c.event === "agent turn")[0]!.properties;
	expect(props.had_tool_error).toBe(true);
	// A tool error result is NOT a busy soft-failure (busy is isError: false).
	expect(props.had_busy_result).toBe(false);
});

test("had_busy_result is true when a non-error result carries the `{ busy: true }` marker", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnEnd(assistantTurnMessage(), [
		turnToolResult({ toolName: "execute_code", details: { busy: true } }),
	]);

	const props = posthog.captures.filter((c) => c.event === "agent turn")[0]!.properties;
	expect(props.had_busy_result).toBe(true);
	expect(props.had_tool_error).toBe(false);
});

test("cache_read_tokens is omitted when usage carries no cacheRead", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnEnd(assistantTurnMessage({ noCacheRead: true }), []);

	const props = posthog.captures.filter((c) => c.event === "agent turn")[0]!.properties;
	expect(Object.prototype.hasOwnProperty.call(props, "cache_read_tokens")).toBe(false);
	// tool_calls=0 && stop_reason defaults to toolUse here; the "agent did
	// nothing" slice is tool_calls=0 && stop_reason=stop (asserted next).
	expect(props.tool_calls).toBe(0);
	expect(props.tool_names).toEqual([]);
});

test("the `tool_calls=0 && stop_reason=stop` slice captures cleanly (the 'agent did nothing' turn)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordTurnEnd(assistantTurnMessage({ stopReason: "stop", output: 0 }), []);

	const props = posthog.captures.filter((c) => c.event === "agent turn")[0]!.properties;
	expect(props.tool_calls).toBe(0);
	expect(props.stop_reason).toBe("stop");
	expect(props.output_tokens).toBe(0); // flags an empty response
});

test("recordTurnEnd() skips capture for a non-assistant turn_end message (best-effort, no crash)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	// A toolResult message is not the assistant message the recorder expects.
	const toolResultMessage = {
		role: "toolResult",
		toolName: "x",
		isError: false,
	} as unknown as AgentMessage;
	instr.recordTurnEnd(toolResultMessage, [turnToolResult()]);

	expect(posthog.captures.filter((c) => c.event === "agent turn")).toHaveLength(0);
	// turn_index is NOT advanced on a skipped turn — the counter tracks turns
	// that actually produced a capture. (The agent loop always emits the
	// assistant message, so this path is purely defensive.)
	instr.recordTurnEnd(assistantTurnMessage(), []);
	expect(posthog.captures.filter((c) => c.event === "agent turn")).toHaveLength(1);
	expect(posthog.captures[0]!.properties.turn_index).toBe(0);
});

// ---- `tool call` (recordToolStart / recordToolProgress / recordToolEnd) ----

/**
 * A `tool_execution_end.result` stub. `recordToolEnd` reads only
 * `result.details` (for the busy check + feature count); content text is
 * never touched. Mirrors the real pi-agent-core shape at that granularity.
 */
function toolExecResult(details?: unknown): unknown {
	return {
		content: [{ type: "text", text: "stub" }],
		...(details !== undefined ? { details } : {}),
	};
}

test("recordToolEnd() captures exactly one `tool call` for a successful data-fetch tool with result_count", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd(
		"call-1",
		"execute_code",
		toolExecResult({ stdout: "stub", displays: [{ markers: [{ lat: 0, lon: 0 }] }] }),
		false,
	);

	const calls = posthog.captures.filter((c) => c.event === "tool call");
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({ distinctId: "conv-1" });
	expect(calls[0]!.properties).toEqual({
		$process_person_profile: false,
		tool_name: "execute_code",
		outcome: "success",
		duration_ms: calls[0]!.properties.duration_ms,
		result_count: 1,
	});
	expect(Number.isInteger(calls[0]!.properties.duration_ms)).toBe(true);
	// queue_wait_ms omitted — tool never queued.
	expect(Object.prototype.hasOwnProperty.call(calls[0]!.properties, "queue_wait_ms")).toBe(false);
});

test("recordToolEnd() derives outcome=empty for a zero-feature data-fetch tool", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd(
		"call-1",
		"execute_code",
		toolExecResult({ stdout: "", displays: [] }),
		false,
	);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(props.outcome).toBe("empty");
	expect(props.result_count).toBe(0);
});

test("recordToolEnd() derives outcome=busy for a non-error busy soft-failure", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({ busy: true }), false);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(props.outcome).toBe("busy");
	// result_count omitted for busy (not a data-fetch outcome path).
	expect(Object.prototype.hasOwnProperty.call(props, "result_count")).toBe(false);
});

test("recordToolEnd() derives outcome=error when isError is true", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({}), true);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(props.outcome).toBe("error");
	// result_count omitted for errors.
	expect(Object.prototype.hasOwnProperty.call(props, "result_count")).toBe(false);
});

test("recordToolProgress tracks queue_wait_ms from queued → running", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolProgress("call-1", { type: "queued" });
	instr.recordToolProgress("call-1", { type: "running" });
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({ data: [] }), false);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(Number.isInteger(props.queue_wait_ms)).toBe(true);
	expect(props.queue_wait_ms as number).toBeGreaterThanOrEqual(0);
});

test("recordToolEnd() cleans up the tracking entry (no leak across calls)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({ data: [] }), false);
	// A second tool with the same id starts fresh — duration_ms should not
	// carry over from the first.
	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({ data: [] }), false);

	const calls = posthog.captures.filter((c) => c.event === "tool call");
	expect(calls).toHaveLength(2);
});

test("recordToolEnd() handles a missing tracking entry (defensive: measures from stream start)", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	// tool_execution_end without a preceding start (shouldn't happen — the
	// agent loop always emits start first — but must not crash).
	instr.recordToolEnd("orphan", "execute_code", toolExecResult({ data: [] }), false);

	const calls = posthog.captures.filter((c) => c.event === "tool call");
	expect(calls).toHaveLength(1);
	expect(Number.isInteger(calls[0]!.properties.duration_ms)).toBe(true);
});

// ---- total_tool_ms on stream events -----------------------------------------

test("complete() ships total_tool_ms = sum of tool durations", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({}), false);
	instr.recordToolStart("call-2");
	instr.recordToolEnd("call-2", "execute_code", toolExecResult({}), false);

	instr.complete();

	const done = posthog.captures.filter((c) => c.event === "agent stream done")[0]!;
	const toolDurations = posthog.captures
		.filter((c) => c.event === "tool call")
		.reduce((sum, c) => sum + (c.properties.duration_ms as number), 0);
	expect(done.properties.total_tool_ms).toBe(toolDurations);
	expect(Number.isInteger(done.properties.total_tool_ms)).toBe(true);
});

test("complete() ships total_tool_ms = 0 when no tools ran", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.complete();

	const done = posthog.captures.filter((c) => c.event === "agent stream done")[0]!;
	expect(done.properties.total_tool_ms).toBe(0);
});

test("disconnect() ships total_tool_ms from completed tools only", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd("call-1", "execute_code", toolExecResult({}), false);
	// Simulate an in-flight tool that never completes (user aborts mid-call).
	instr.recordToolStart("call-2");

	instr.disconnect();

	const disconnect = posthog.captures.filter((c) => c.event === "agent stream disconnect")[0]!;
	const firstToolDuration = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties
		.duration_ms as number;
	expect(disconnect.properties.total_tool_ms).toBe(firstToolDuration);
});

// ---- primitive trace on tool call -------------------------------------------

test("recordToolEnd() derives primitives[] and primitive_timings_ms from details.primitives", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd(
		"call-1",
		"execute_code",
		toolExecResult({
			stdout: "",
			displays: [{ features: [{ lat: 0, lon: 0 }] }],
			primitives: [
				{ name: "geocode", duration_ms: 200 },
				{ name: "find_features", duration_ms: 3400 },
				{ name: "find_features", duration_ms: 1200 },
				{ name: "profile", duration_ms: 3 },
				{ name: "display", duration_ms: 0 },
			],
		}),
		false,
	);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(props.primitives).toEqual([
		"geocode",
		"find_features",
		"find_features",
		"profile",
		"display",
	]);
	expect(props.primitive_timings_ms).toEqual({
		geocode: 200,
		find_features: 4600,
		profile: 3,
		display: 0,
	});
});

test("recordToolEnd() omits primitives/primitive_timings_ms when details has no trace", () => {
	const { logger } = mockLogger();
	const posthog = spyPostHog();
	const instr = new StreamInstrumentation("conv-1", posthog, logger);

	instr.recordToolStart("call-1");
	instr.recordToolEnd(
		"call-1",
		"execute_code",
		toolExecResult({ stdout: "", displays: [] }),
		false,
	);

	const props = posthog.captures.filter((c) => c.event === "tool call")[0]!.properties;
	expect(Object.prototype.hasOwnProperty.call(props, "primitives")).toBe(false);
	expect(Object.prototype.hasOwnProperty.call(props, "primitive_timings_ms")).toBe(false);
});
