/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { PostHog } from "posthog-js";
import {
	captureReactError,
	captureMessageSent,
	captureMapOpened,
	captureToolError,
} from "./posthog-capture.ts";

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

test("product-analytics helpers no-op when PostHog is disabled (client undefined)", () => {
	expect(() => captureMessageSent(undefined, { isNewConversation: true })).not.toThrow();
	expect(() => captureMapOpened(undefined, { markerCount: 3 })).not.toThrow();
	expect(() => captureToolError(undefined, "query_osm")).not.toThrow();
});

test("captureMessageSent emits message_sent with the new-conversation flag", () => {
	const { client, captured } = recordingClient();

	captureMessageSent(client, { isNewConversation: true });
	captureMessageSent(client, { isNewConversation: false });

	expect(captured).toEqual([
		{ event: "message_sent", props: { is_new_conversation: true } },
		{ event: "message_sent", props: { is_new_conversation: false } },
	]);
});

test("captureMapOpened emits map_opened with the marker count", () => {
	const { client, captured } = recordingClient();

	captureMapOpened(client, { markerCount: 42 });

	expect(captured).toEqual([{ event: "map_opened", props: { marker_count: 42 } }]);
});

test("captureToolError emits tool_error with the tool name only", () => {
	const { client, captured } = recordingClient();

	captureToolError(client, "query_osm");

	expect(captured).toEqual([{ event: "tool_error", props: { tool_name: "query_osm" } }]);
});
