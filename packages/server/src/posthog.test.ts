/// <reference types="bun" />
import { test, expect } from "bun:test";
import {
	captureAnalytics,
	createPostHogAnalyticsClient,
	type PostHogAnalyticsClient,
} from "./posthog.ts";

interface Captured {
	distinctId: string;
	event: string;
	properties: Record<string, unknown>;
}

/**
 * Minimal hand-rolled spy standing in for the analytics client — mirrors the
 * recording-client pattern in `packages/web/src/lib/posthog-capture.test.ts`.
 * `shutdown` is a no-op async fn so the graceful-shutdown hook typechecks.
 */
function spyClient(): { client: PostHogAnalyticsClient; captures: Captured[] } {
	const captures: Captured[] = [];
	const client: PostHogAnalyticsClient = {
		capture: (msg) => captures.push({ ...msg, properties: { ...msg.properties } }),
		shutdown: async () => {},
	};
	return { client, captures };
}

test("captureAnalytics no-ops when the client is undefined (the off-switch)", () => {
	const { captures } = spyClient();
	// The spy above is deliberately NOT passed — the undefined path must neither
	// throw nor touch any client. captures stays empty to prove nothing fired.
	expect(() =>
		captureAnalytics(undefined, { distinctId: "c1", name: "conversation started" }),
	).not.toThrow();
	expect(captures).toHaveLength(0);
});

test("captureAnalytics merges $process_person_profile: false and preserves caller properties", () => {
	const { client, captures } = spyClient();

	captureAnalytics(client, {
		distinctId: "c1",
		name: "message sent",
		properties: { message_length: 42 },
	});

	expect(captures).toHaveLength(1);
	expect(captures[0]).toEqual({
		distinctId: "c1",
		event: "message sent",
		properties: { $process_person_profile: false, message_length: 42 },
	});
});

test("captureAnalytics sets $process_person_profile: false even with no caller properties", () => {
	const { client, captures } = spyClient();

	captureAnalytics(client, { distinctId: "c1", name: "conversation deleted" });

	expect(captures).toHaveLength(1);
	expect(captures[0]?.properties).toEqual({ $process_person_profile: false });
});

test("captureAnalytics passes distinctId and event name through verbatim", () => {
	const { client, captures } = spyClient();

	captureAnalytics(client, {
		distinctId: "203.0.113.7",
		name: "rate limit exceeded",
		properties: { path: "/conversations" },
	});

	expect(captures).toHaveLength(1);
	expect(captures[0]?.distinctId).toBe("203.0.113.7");
	expect(captures[0]?.event).toBe("rate limit exceeded");
});

test("createPostHogAnalyticsClient constructs without throwing (smoke)", async () => {
	const client = createPostHogAnalyticsClient({
		apiKey: "test",
		host: "https://eu.i.posthog.com",
	});
	expect(typeof client.capture).toBe("function");
	expect(typeof client.shutdown).toBe("function");
	// Clean up any timers the constructor may have armed; no events queued, so
	// shutdown makes no network calls.
	await client.shutdown();
});
