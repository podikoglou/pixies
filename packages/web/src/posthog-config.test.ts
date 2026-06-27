/// <reference types="bun" />
import { expect, test } from "bun:test";
import { resolvePostHogConfig } from "./posthog-config";

/**
 * `resolvePostHogConfig` turns the two `VITE_POSTHOG_*` values Vite inlines at
 * build time into a resolved config. These tests pin its contract: the key is
 * the telemetry off-switch (unset/empty/whitespace ⇒ off, set ⇒ on with
 * validated values), and the host is normalized empty-as-unset so the
 * documented default applies — matching the server's `env()` helper. A
 * malformed (non-empty, non-url) host is still rejected at config parse, not
 * inside the PostHog SDK. Mirrors the server's PostHog config tests in
 * `@pixies/core` agent.test.ts.
 */

test("unset key leaves telemetry off (no key/host on the resolved config)", () => {
	const config = resolvePostHogConfig({});
	expect(config).toEqual({ enabled: false });
});

test("empty-string key is treated as unset (off-switch)", () => {
	const config = resolvePostHogConfig({ key: "" });
	expect(config).toEqual({ enabled: false });
});

test("whitespace-only key is treated as unset (off-switch)", () => {
	const config = resolvePostHogConfig({ key: "  " });
	expect(config).toEqual({ enabled: false });
});

test("set key with unset host enables telemetry and applies the host default", () => {
	const config = resolvePostHogConfig({ key: "phc-token" });
	expect(config).toEqual({ enabled: true, key: "phc-token", host: "https://app.posthog.com" });
});

test("set key with explicit host enables telemetry and honors the host override", () => {
	const config = resolvePostHogConfig({ key: "phc-token", host: "https://eu.i.posthog.com" });
	expect(config).toEqual({ enabled: true, key: "phc-token", host: "https://eu.i.posthog.com" });
});

test("empty host with key set is treated as unset, so the documented default applies", () => {
	const config = resolvePostHogConfig({ key: "phc-token", host: "" });
	expect(config).toEqual({ enabled: true, key: "phc-token", host: "https://app.posthog.com" });
});

test("empty host with key unset leaves telemetry off (does not throw at module load)", () => {
	const config = resolvePostHogConfig({ host: "" });
	expect(config).toEqual({ enabled: false });
});

test('malformed host is rejected at config parse ("not-a-url")', () => {
	expect(() => resolvePostHogConfig({ key: "phc-token", host: "not-a-url" })).toThrow();
});

test("malformed host is rejected even with key unset (parity with the server)", () => {
	expect(() => resolvePostHogConfig({ host: "not-a-url" })).toThrow();
});
