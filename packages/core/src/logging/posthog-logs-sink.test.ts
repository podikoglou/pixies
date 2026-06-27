/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { redactRecord, DEFAULT_REDACT_KEYS, getPostHogLogsSink } from "./posthog-logs-sink.ts";

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

// ---- 1. redacts a matching url property -------------------------------------

test("redactRecord replaces a matching url property with [redacted]", () => {
	const r = record("info", "nominatim request", {
		url: "https://nominatim.test/search?q=Kreuzberg",
		statusCode: 200,
	});

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.url).toBe("[redacted]");
	expect(out.properties.statusCode).toBe(200);
});

// ---- 2. does not mutate the input (console still sees original) -------------

test("redactRecord does not mutate the input record", () => {
	const r = record("info", "nominatim request", {
		url: "https://nominatim.test/search?q=Kreuzberg",
	});
	const originalUrl = r.properties.url;

	redactRecord(r, DEFAULT_REDACT_KEYS);

	// The caller's record (e.g. the console sink) must still see full detail.
	expect(r.properties.url).toBe(originalUrl);
});

// ---- 3. returns the same reference when nothing matches ---------------------

test("redactRecord returns the same record reference when no keys match", () => {
	const r = record("info", "request", { statusCode: 200, durationMs: 12 });

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	// No allocation — nothing to scrub.
	expect(out).toBe(r);
});

// ---- 4. scrubs multiple keys and leaves others intact -----------------------

test("redactRecord scrubs multiple keys and leaves other keys intact", () => {
	const r = record("debug", "search", {
		url: "https://nominatim.test/search?q=cafe",
		query: "cafe near me",
		conversationId: "abc",
		durationMs: 42,
	});

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.url).toBe("[redacted]");
	expect(out.properties.query).toBe("[redacted]");
	expect(out.properties.conversationId).toBe("abc");
	expect(out.properties.durationMs).toBe(42);
});

// ---- 5. redacts cause (TypeBox parse errors carry the full response) --------

test("redactRecord replaces a cause property (TypeBox parse error payload) with [redacted]", () => {
	// TypeBox's Value.Parse throws an AssertError whose non-enumerable `cause`
	// is { source, errors, value } — `value` is the entire parsed response
	// (place names). @logtape/otel serializes value.cause regardless of
	// enumerability, so the record's top-level `cause` must be scrubbed.
	const err = new Error("Parse");
	Object.defineProperty(err, "cause", {
		value: { source: "Parse", errors: [], value: { display_name: "10 Downing Street" } },
		enumerable: false,
	});
	const r = record("warning", "invalid response shape", {
		service: "Nominatim",
		statusCode: 200,
		contentType: "application/json",
		cause: err,
	});

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.cause).toBe("[redacted]");
	expect(out.properties.statusCode).toBe(200);
	expect(out.properties.service).toBe("Nominatim");
});

// ---- 6. honors a custom keys argument ---------------------------------------

test("redactRecord honors a custom keys argument", () => {
	const r = record("info", "request", { secret: "shh", url: "ok-to-keep" });

	const out = redactRecord(r, ["secret"]);

	expect(out.properties.secret).toBe("[redacted]");
	// `url` is NOT in the custom key set, so it survives.
	expect(out.properties.url).toBe("ok-to-keep");
});

// ---- 7. smoke: getPostHogLogsSink constructs without throwing ---------------

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
