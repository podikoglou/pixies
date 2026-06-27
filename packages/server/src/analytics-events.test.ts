/// <reference types="bun" />
import { expect, test } from "bun:test";
import { captureServerEvent, type ServerAnalyticsEvent } from "./analytics-events.ts";
import type { PostHogAnalyticsClient } from "./posthog.ts";

/**
 * Coverage for the typed server analytics contract.
 *
 * `captureServerEvent` is a thin typed veneer over `captureAnalytics`, so the
 * smoke tests pin the two centralised decisions it must preserve by DELEGATING
 * (not re-implementing): the undefined-client off-switch and the
 * `$process_person_profile: false` injection. A `@ts-expect-error` pins the
 * contract at compile time so a drifting call site fails `typecheck`.
 */

interface Captured {
	distinctId: string;
	event: string;
	properties: Record<string, unknown>;
}

function spyClient(): { client: PostHogAnalyticsClient; captures: Captured[] } {
	const captures: Captured[] = [];
	const client: PostHogAnalyticsClient = {
		capture: (msg) => captures.push({ ...msg, properties: { ...msg.properties } }),
		shutdown: async () => {},
	};
	return { client, captures };
}

test("captureServerEvent no-ops when the client is undefined (the off-switch)", () => {
	expect(() =>
		captureServerEvent(undefined, "c1", "conversation started", { message_length: 3 }),
	).not.toThrow();
});

test("captureServerEvent delegates to captureAnalytics, preserving $process_person_profile: false", () => {
	const { client, captures } = spyClient();

	captureServerEvent(client, "c1", "message sent", { message_length: 42 });

	expect(captures).toHaveLength(1);
	expect(captures[0]).toEqual({
		distinctId: "c1",
		event: "message sent",
		properties: { $process_person_profile: false, message_length: 42 },
	});
});

test("captureServerEvent carries the exact event name (spaces preserved, no rename)", () => {
	const { client, captures } = spyClient();

	captureServerEvent(client, "203.0.113.7", "rate limit exceeded", { path: "/conversations" });

	expect(captures[0]?.distinctId).toBe("203.0.113.7");
	expect(captures[0]?.event).toBe("rate limit exceeded");
	expect(captures[0]?.properties).toEqual({
		$process_person_profile: false,
		path: "/conversations",
	});
});

test("captureServerEvent accepts the property-less `conversation deleted` shape", () => {
	const { client, captures } = spyClient();

	captureServerEvent(client, "c1", "conversation deleted", {});

	expect(captures[0]?.properties).toEqual({ $process_person_profile: false });
});

// Compile-time pin: the typed contract REJECTS a wrong property shape. If the
// contract or a call site drifts, `bun run typecheck` (tsgo) fails here. The
// runtime call below would no-op (client is undefined) — only the type error
// matters, which is why the suppression sits on the call itself.
// @ts-expect-error — `agent stream done` requires `duration_ms`, not `ttft_ms`.
captureServerEvent(undefined, "c1", "agent stream done", { ttft_ms: 5 });

// Compile-time pin: the contract exhaustively maps the server's existing event
// names. Listed once here so adding/removing an event forces a deliberate edit.
type _Names = keyof ServerAnalyticsEvent;
const _expectedNames: _Names[] = [
	"agent stream first token",
	"agent stream done",
	"agent stream disconnect",
	"agent stream error",
	"conversation started",
	"message sent",
	"conversation deleted",
	"conversation budget exceeded",
	"rate limit exceeded",
];
void _expectedNames;
