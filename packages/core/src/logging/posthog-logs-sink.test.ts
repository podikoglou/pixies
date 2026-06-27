/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { allowlistRecord, DEFAULT_ALLOW_KEYS, getPostHogLogsSink } from "./posthog-logs-sink.ts";

/** Build a real LogTape LogRecord for tests. */
function record(
	level: LogRecord["level"],
	message: string,
	properties: Record<string, unknown> = {},
	timestamp = 1_700_000_000_000,
): LogRecord {
	return {
		category: ["pixies"],
		level,
		message: [message],
		rawMessage: message,
		timestamp,
		properties,
	};
}

// ---- 1. allowed keys pass; everything else is scrubbed -----------------------

test("allowlistRecord passes allowed keys and scrubs the rest", () => {
	const r = record("error", "failed to insert conversation", {
		conversationId: "abc",
		statusCode: 500,
		err: new Error("boom"),
	});

	const out = allowlistRecord(r, DEFAULT_ALLOW_KEYS);

	expect(out.properties.conversationId).toBe("abc");
	expect(out.properties.statusCode).toBe(500);
	expect(out.properties.err).toBe("[redacted]");
});

// ---- 2. does not mutate the input (console still sees original) --------------

test("allowlistRecord does not mutate the input record", () => {
	const err = new Error("boom");
	const r = record("error", "failed", { err });

	allowlistRecord(r, DEFAULT_ALLOW_KEYS);

	// The caller's record (e.g. the console sink) must still see full detail.
	expect(r.properties.err).toBe(err);
});

// ---- 3. returns the same reference when every property is allowed ------------

test("allowlistRecord returns the same record reference when every property is allowed", () => {
	const r = record("info", "request", { statusCode: 200, durationMs: 12 });

	const out = allowlistRecord(r, DEFAULT_ALLOW_KEYS);

	// No allocation — nothing to scrub.
	expect(out).toBe(r);
});

// ---- 4. the default allowlist scrubs every known leak key --------------------
// Pins the contract that closes the leaks behind #220/#221/#222: a denylist
// could only block keys we remembered; the allowlist ships them scrubbed by
// default because none are approved.

test("the default allowlist scrubs every location/ip/error-bearing key and keeps safe metadata", () => {
	const r = record("warning", "leaks", {
		url: "https://nominatim.test/search?q=cafe",
		query: "cafe near me",
		err: new Error("raw OSM body"),
		ip: "203.0.113.7",
		cause: new Error("invalid response shape"),
		remark: "runtime error text",
		// known-safe metadata that must still ship
		conversationId: "abc",
		durationMs: 42,
		service: "Overpass",
	});

	const out = allowlistRecord(r, DEFAULT_ALLOW_KEYS);

	expect(out.properties.url).toBe("[redacted]");
	expect(out.properties.query).toBe("[redacted]");
	expect(out.properties.err).toBe("[redacted]");
	expect(out.properties.ip).toBe("[redacted]");
	expect(out.properties.cause).toBe("[redacted]");
	expect(out.properties.remark).toBe("[redacted]");
	expect(out.properties.conversationId).toBe("abc");
	expect(out.properties.durationMs).toBe(42);
	expect(out.properties.service).toBe("Overpass");
});

// ---- 5. honors a custom allowKeys argument -----------------------------------

test("allowlistRecord honors a custom allowKeys argument", () => {
	const r = record("info", "x", { keep: "yes", scrub: "no" });

	const out = allowlistRecord(r, ["keep"]);

	expect(out.properties.keep).toBe("yes");
	// `scrub` is not in the custom allow set, so it is redacted.
	expect(out.properties.scrub).toBe("[redacted]");
});

// ---- 6. smoke: getPostHogLogsSink constructs without throwing ----------------

test("getPostHogLogsSink constructs without throwing (import compat)", () => {
	// Transitively imports @logtape/otel + its OTel deps on Bun. We do NOT feed
	// records to the returned sink — that would arm the OTel batch timers and
	// risk a real HTTP flush / process hang on exit.
	const sink = getPostHogLogsSink({
		endpoint: "http://127.0.0.1:9/i/v1/logs",
		token: "test",
	});
	expect(typeof sink).toBe("function");
});
