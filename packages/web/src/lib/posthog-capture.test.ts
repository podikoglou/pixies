/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { PostHog } from "posthog-js";
import { captureReactError, captureEvent, toolResultCount } from "./posthog-capture.ts";

interface Recorded {
	error: unknown;
	props: unknown;
}

interface Captured {
	event: string;
	props: unknown;
}

/** Minimal hand-rolled spy standing in for the PostHog client. */
function recordingClient(): {
	client: PostHog;
	recorded: Recorded[];
	captured: Captured[];
} {
	const recorded: Recorded[] = [];
	const captured: Captured[] = [];
	const client = {
		captureException: (error: unknown, props: unknown) => recorded.push({ error, props }),
		capture: (event: string, props: unknown) => captured.push({ event, props }),
	} as unknown as PostHog;
	return { client, recorded, captured };
}

test("no-ops when PostHog is disabled (client undefined)", () => {
	expect(() => captureReactError(undefined, new Error("boom"), "  at Foo")).not.toThrow();
});

test("forwards the error and componentStack to captureException when enabled", () => {
	const { client, recorded } = recordingClient();
	const err = new Error("boom");

	captureReactError(client, err, "  at Foo\n  at Bar");

	expect(recorded).toHaveLength(1);
	expect(recorded[0]?.error).toBe(err);
	expect(recorded[0]?.props).toEqual({ componentStack: "  at Foo\n  at Bar" });
});

test("tolerates non-Error throwables", () => {
	const { client, recorded } = recordingClient();

	captureReactError(client, "string thrown", "stack");

	expect(recorded).toHaveLength(1);
	expect(recorded[0]?.error).toBe("string thrown");
});

test("captureEvent no-ops when PostHog is disabled (client undefined)", () => {
	expect(() =>
		captureEvent(undefined, "message_sent", { is_new_conversation: true }),
	).not.toThrow();
	expect(() => captureEvent(undefined, "map_opened", { marker_count: 3 })).not.toThrow();
	expect(() => captureEvent(undefined, "tool_error", { tool_name: "execute_code" })).not.toThrow();
	expect(() =>
		captureEvent(undefined, "tool_empty", { tool_name: "execute_code", result_count: 0 }),
	).not.toThrow();
	expect(() => captureEvent(undefined, "user_stop", { had_output: true })).not.toThrow();
});

test("captureEvent emits message_sent with the new-conversation flag", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "message_sent", { is_new_conversation: true });
	captureEvent(client, "message_sent", { is_new_conversation: false });

	expect(captured).toEqual([
		{ event: "message_sent", props: { is_new_conversation: true } },
		{ event: "message_sent", props: { is_new_conversation: false } },
	]);
});

test("captureEvent emits map_opened with the marker count", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "map_opened", { marker_count: 42 });

	expect(captured).toEqual([{ event: "map_opened", props: { marker_count: 42 } }]);
});

test("captureEvent emits tool_error with the tool name only", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "tool_error", { tool_name: "execute_code" });

	expect(captured).toEqual([{ event: "tool_error", props: { tool_name: "execute_code" } }]);
});

test("captureEvent emits tool_empty with the tool name and feature count", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "tool_empty", { tool_name: "execute_code", result_count: 0 });

	expect(captured).toEqual([
		{ event: "tool_empty", props: { tool_name: "execute_code", result_count: 0 } },
	]);
});

test("captureEvent emits user_stop with the had_output flag", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "user_stop", { had_output: true });
	captureEvent(client, "user_stop", { had_output: false });

	expect(captured).toEqual([
		{ event: "user_stop", props: { had_output: true } },
		{ event: "user_stop", props: { had_output: false } },
	]);
});

// ---- toolResultCount --------------------------------------------------------
// `details` mirrors the execute_code `details` shape: `{ stdout, displays }`
// where each display may carry `features` or `markers`. Busy soft-failures use
// `{ busy: true }`. See parse-result.test.ts.

const feature = { id: "node/1", lat: 1, lon: 2, name: "A" };

test("toolResultCount execute_code — empty displays is 0", () => {
	expect(toolResultCount("execute_code", { stdout: "", displays: [] })).toBe(0);
});

test("toolResultCount execute_code — counts features across displays", () => {
	expect(
		toolResultCount("execute_code", {
			stdout: "",
			displays: [{ features: [feature, feature, feature] }],
		}),
	).toBe(3);
});

test("toolResultCount execute_code — falls back to markers when no features", () => {
	expect(
		toolResultCount("execute_code", {
			stdout: "",
			displays: [
				{
					markers: [
						{ lat: 1, lon: 2 },
						{ lat: 3, lon: 4 },
					],
				},
			],
		}),
	).toBe(2);
});

test("toolResultCount execute_code — busy soft-failure does not fire", () => {
	expect(toolResultCount("execute_code", { busy: true })).toBeUndefined();
});

test("toolResultCount — non-data-fetch and unknown tools do not fire", () => {
	expect(toolResultCount("display_map", { data: { markers: [] } })).toBeUndefined();
	expect(toolResultCount("some_other_tool", { data: [feature] })).toBeUndefined();
});
