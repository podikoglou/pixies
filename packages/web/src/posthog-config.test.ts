/// <reference types="bun" />
import { expect, test } from "bun:test";
import { resolvePostHogConfig } from "./posthog-config";

/**
 * `resolvePostHogConfig` turns the two `VITE_POSTHOG_*` values Vite inlines at
 * build time into a resolved config. These tests pin its contract: the key is
 * the telemetry off-switch (unset/empty ⇒ off, set ⇒ on with validated values),
 * the host gets its documented default when unset, and a malformed host is
 * rejected at config parse rather than inside the PostHog SDK. Mirrors the
 * server's PostHog config tests in `@pixies/core` agent.test.ts.
 */

test("unset key leaves telemetry off (no key/host on the resolved config)", () => {
	const config = resolvePostHogConfig({});
	expect(config).toEqual({ enabled: false });
});

test('empty-string key is treated as unset (off-switch — `"".length > 0` is false)', () => {
	const config = resolvePostHogConfig({ key: "" });
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

test('malformed host is rejected at config parse ("not-a-url")', () => {
	expect(() => resolvePostHogConfig({ key: "phc-token", host: "not-a-url" })).toThrow();
});
