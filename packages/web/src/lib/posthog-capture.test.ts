/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { PostHog } from "posthog-js";
import { captureReactError } from "./posthog-capture.ts";

interface Recorded {
	error: unknown;
	props: unknown;
}

/** Minimal hand-rolled spy standing in for the PostHog client. */
function recordingClient(): { client: PostHog; recorded: Recorded[] } {
	const recorded: Recorded[] = [];
	const client = {
		captureException: (error: unknown, props: unknown) => recorded.push({ error, props }),
	} as unknown as PostHog;
	return { client, recorded };
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
