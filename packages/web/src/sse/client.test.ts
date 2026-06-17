/// <reference types="bun" />
import { test, expect } from "bun:test";
import { ApiError, buildApiError, extractErrorMessage } from "./client.ts";

/**
 * Schema-driven `extractErrorMessage` / `buildApiError` (issue #106 Gap 3).
 *
 * The server's HTTP error responses are `Response.json({ error: "..." }, ...)`.
 * `extractErrorMessage` validates the body against a TypeBox `{ error: string }`
 * schema instead of hand-rolled `typeof` / `"error" in body` checks. These tests
 * pin the contract: valid shape extracts the string; anything else yields
 * `undefined` and `buildApiError` falls back to a status-code message.
 */

// ---- extractErrorMessage ----------------------------------------------------

test("extractErrorMessage returns the string for a valid { error } body [#106]", () => {
	expect(extractErrorMessage({ error: "boom" })).toBe("boom");
});

test("extractErrorMessage returns undefined for null [#106]", () => {
	expect(extractErrorMessage(null)).toBeUndefined();
});

test("extractErrorMessage returns undefined for a string body [#106]", () => {
	expect(extractErrorMessage("boom")).toBeUndefined();
});

test('extractErrorMessage returns undefined for { message: "..." } (not the contracted shape) [#106]', () => {
	expect(extractErrorMessage({ message: "hi" })).toBeUndefined();
});

test("extractErrorMessage returns undefined for { error: 123 } (non-string) [#106]", () => {
	expect(extractErrorMessage({ error: 123 })).toBeUndefined();
});

test("extractErrorMessage returns undefined for { error: undefined } [#106]", () => {
	expect(extractErrorMessage({ error: undefined })).toBeUndefined();
});

test("extractErrorMessage tolerates extra fields (forward-compatible with errorTag/details) [#106]", () => {
	expect(extractErrorMessage({ error: "boom", errorTag: "Foo", extra: 1 })).toBe("boom");
});

// ---- buildApiError end-to-end ----------------------------------------------

test("buildApiError falls back to status text when body has no error field [#106]", async () => {
	const res = new Response(JSON.stringify({ message: "hi" }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});
	const err = await buildApiError(res);
	expect(err).toBeInstanceOf(ApiError);
	expect(err.message).toBe("request failed with status 503");
	expect(err.status).toBe(503);
});

test('buildApiError surfaces the error string when body is { error: "boom" } [#106]', async () => {
	const res = new Response(JSON.stringify({ error: "boom" }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
	const err = await buildApiError(res);
	expect(err).toBeInstanceOf(ApiError);
	expect(err.message).toBe("boom");
	expect(err.status).toBe(500);
});
