/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import { OverpassBusyError } from "@pixies/core";
import { type Logger } from "@pixies/core/logging";
import { StreamInstrumentation } from "./stream-instrumentation.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/**
 * Direct unit coverage for the {@link StreamInstrumentation} seam — the issue's
 * headline benefit. These tests exercise timing + analytics in isolation,
 * WITHOUT an SSE round-trip (`pipe-agent-stream.test.ts` still pins the
 * end-to-end wire + lifecycle). The tag-only-on-error privacy property is
 * asserted here directly, not just indirectly through the wire bytes.
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
