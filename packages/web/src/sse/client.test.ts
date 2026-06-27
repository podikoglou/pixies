/// <reference types="bun" />
import { test, expect } from "bun:test";
import { ApiError, buildApiError, extractErrorMessage } from "./client.ts";

/**
 * Schema-driven `extractErrorMessage` / `buildApiError`.
 *
 * The server's HTTP error responses are `Response.json({ error: "..." }, ...)`.
 * `extractErrorMessage` validates the body against a TypeBox `{ error: string }`
 * schema instead of hand-rolled `typeof` / `"error" in body` checks. These
 * tests pin the happy path and our own fallback integration: a valid body
 * extracts the string (tolerating extra fields), and `buildApiError` surfaces
 * it or falls back to a status-code message. Rejection of non-conforming
 * shapes is enforced at compile time by the TypeBox schema and is its
 * responsibility, not ours.
 */

// ---- extractErrorMessage ----------------------------------------------------

test("extractErrorMessage returns the string for a valid { error } body", () => {
	expect(extractErrorMessage({ error: "boom" })).toBe("boom");
});

test("extractErrorMessage tolerates extra fields (forward-compatible with errorTag/details)", () => {
	expect(extractErrorMessage({ error: "boom", errorTag: "Foo", extra: 1 })).toBe("boom");
});

// ---- buildApiError end-to-end ----------------------------------------------

test("buildApiError falls back to status text when body has no error field", async () => {
	const res = new Response(JSON.stringify({ message: "hi" }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});
	const err = await buildApiError(res);
	expect(err).toBeInstanceOf(ApiError);
	expect(err.message).toBe("request failed with status 503");
	expect(err.status).toBe(503);
});

test('buildApiError surfaces the error string when body is { error: "boom" }', async () => {
	const res = new Response(JSON.stringify({ error: "boom" }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
	const err = await buildApiError(res);
	expect(err).toBeInstanceOf(ApiError);
	expect(err.message).toBe("boom");
	expect(err.status).toBe(500);
});
