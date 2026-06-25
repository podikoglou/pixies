/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { PostHog } from "posthog-js";
import { captureReactError, captureEvent } from "./posthog-capture.ts";

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
	expect(() =>
		captureEvent(undefined, "map_opened", { marker_count: 3 }),
	).not.toThrow();
	expect(() =>
		captureEvent(undefined, "tool_error", { tool_name: "query_osm" }),
	).not.toThrow();
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

	captureEvent(client, "tool_error", { tool_name: "query_osm" });

	expect(captured).toEqual([{ event: "tool_error", props: { tool_name: "query_osm" } }]);
});
