/// <reference types="bun" />
import { test, expect } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { TaggedError } from "better-result";
import { redactRecord, DEFAULT_REDACT_KEYS, getPostHogLogsSink } from "./posthog-logs-sink.ts";

/** A TaggedError shaped like the OSM clients' `*HttpError`: a `body` prop and a `message` that embeds it. */
const OverpassHttpError = TaggedError("OverpassHttp")<{
	status?: number;
	body?: string;
	message: string;
}>();

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

// ---- 5. honors a custom keys argument ---------------------------------------

test("redactRecord honors a custom keys argument", () => {
	const r = record("info", "request", { secret: "shh", url: "ok-to-keep" });

	const out = redactRecord(r, ["secret"]);

	expect(out.properties.secret).toBe("[redacted]");
	// `url` is NOT in the custom key set, so it survives.
	expect(out.properties.url).toBe("ok-to-keep");
});

// ---- 6. smoke: getPostHogLogsSink constructs without throwing ---------------

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

// ---- 7. err: TaggedError keeps only the _tag, drops message/body ------------

test("redactRecord keeps only the _tag of a TaggedError under err — never message/body", () => {
	// The headline leak: OSM *HttpError carries the raw response body both as
	// an enumerable `body` prop and embedded in `.message`. @logtape/otel
	// serializes both, so an unscrubbed `err` ships third-party, place-bearing
	// content to PostHog Logs. Only the `_tag` discriminator may survive.
	const err = new OverpassHttpError({
		status: 500,
		body: "raw osm response body",
		message: "Overpass: 500: raw osm response body",
	});
	const r = record("error", "agent stream error", { conversationId: "abc", err });

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.err).toEqual({ _tag: "OverpassHttp" });
	expect(out.properties.conversationId).toBe("abc");
});

// ---- 8. err: plain Error (no _tag) is fully redacted ------------------------

test("redactRecord redacts a plain Error under err", () => {
	const r = record("fatal", "unhandled rejection", { err: new Error("boom: secret") });

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.err).toBe("[redacted]");
});

// ---- 9. err: non-Error values are redacted too ------------------------------

test("redactRecord redacts a non-Error value under err", () => {
	const r = record("error", "persist failed", { conversationId: "x", err: "stringy secret" });

	const out = redactRecord(r, DEFAULT_REDACT_KEYS);

	expect(out.properties.err).toBe("[redacted]");
	expect(out.properties.conversationId).toBe("x");
});

// ---- 10. err: the input record is not mutated -------------------------------

test("redactRecord does not mutate the err value on the input record", () => {
	const err = new OverpassHttpError({ body: "raw osm response body", message: "Overpass: body" });
	const r = record("error", "agent stream error", { err });

	redactRecord(r, DEFAULT_REDACT_KEYS);

	// The console sink must still see the full object.
	expect((r.properties.err as InstanceType<typeof OverpassHttpError>).body).toBe(
		"raw osm response body",
	);
});
