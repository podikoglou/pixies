/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { PostHog } from "posthog-js";
import { captureReactError, captureEvent, toolResultCountBucket } from "./posthog-capture.ts";

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
	expect(() => captureEvent(undefined, "tool_error", { tool_name: "query_osm" })).not.toThrow();
	expect(() =>
		captureEvent(undefined, "tool_empty", { tool_name: "query_osm", result_count_bucket: "0" }),
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

test("captureEvent emits tool_empty with the tool name and count bucket", () => {
	const { client, captured } = recordingClient();

	captureEvent(client, "tool_empty", { tool_name: "query_osm", result_count_bucket: "0" });

	expect(captured).toEqual([
		{ event: "tool_empty", props: { tool_name: "query_osm", result_count_bucket: "0" } },
	]);
});

// ---- toolResultCountBucket ----------------------------------------------------
// `details` stubs mirror the real tool `details` shapes: query_osm/geocode use
// `{ data: entries }`; reverse_geocode uses `{ data: entry }` (or undefined on
// no result); busy soft-failures use `{ busy: true, data: [] }` (geocode) /
// `{ busy: true }` (query_osm, reverse_geocode). See parse-result.test.ts.

const osmEntry = { type: "node" as const, id: 1, lat: 1, lon: 2, name: "A" };
const geocodeEntry = { placeId: 1, lat: 52.5, lon: 13.4, name: "Berlin" };

test("toolResultCountBucket query_osm — empty data is bucket 0", () => {
	expect(toolResultCountBucket("query_osm", { data: [] })).toBe("0");
});

test("toolResultCountBucket query_osm — 1–5 entries is bucket 1–5", () => {
	expect(
		toolResultCountBucket("query_osm", { data: Array.from({ length: 3 }, () => osmEntry) }),
	).toBe("1–5");
});

test("toolResultCountBucket query_osm — 6+ entries is bucket 6+", () => {
	expect(
		toolResultCountBucket("query_osm", { data: Array.from({ length: 6 }, () => osmEntry) }),
	).toBe("6+");
});

test("toolResultCountBucket geocode — empty data is bucket 0", () => {
	expect(toolResultCountBucket("geocode", { data: [] })).toBe("0");
});

test("toolResultCountBucket geocode — busy soft-failure does not fire", () => {
	expect(toolResultCountBucket("geocode", { busy: true, data: [] })).toBeUndefined();
});

test("toolResultCountBucket query_osm — busy soft-failure does not fire", () => {
	expect(toolResultCountBucket("query_osm", { busy: true })).toBeUndefined();
});

test("toolResultCountBucket reverse_geocode — success is bucket 1–5 (single entry)", () => {
	expect(
		toolResultCountBucket("reverse_geocode", { data: { placeId: 9, lat: 1, lon: 2, name: "X" } }),
	).toBe("1–5");
});

test("toolResultCountBucket reverse_geocode — no result (undefined details) is bucket 0", () => {
	expect(toolResultCountBucket("reverse_geocode", undefined)).toBe("0");
});

test("toolResultCountBucket display_map does not fire", () => {
	expect(toolResultCountBucket("display_map", { data: { markers: [] } })).toBeUndefined();
});

test("toolResultCountBucket unknown tool does not fire", () => {
	expect(toolResultCountBucket("some_other_tool", { data: [geocodeEntry] })).toBeUndefined();
});
