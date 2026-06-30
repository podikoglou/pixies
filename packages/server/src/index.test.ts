/// <reference types="bun" />
import { afterAll, expect, test } from "bun:test";
import { type ResolvedPixiesConfig } from "@pixies/core";
import { silentLogger } from "@pixies/core/logging";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "./index.ts";
import { readServerConfigFromEnv } from "./config.ts";

/**
 * Regression: `startServer` used to call
 * `migrate({ migrationsFolder: "./drizzle" })`, which is cwd-relative. The
 * `drizzle/` folder lives at the repo root, so booting the server from any
 * cwd other than the repo root (e.g. `bun test` from `packages/server`)
 * threw `Can't find meta/_journal.json file`. The folder is now resolved
 * via `import.meta.dir`, mirroring the `WEB_DIST` pattern.
 *
 * This test boots the real `startServer` from this package's directory and
 * hits `/health` — proving migrations ran. It does not exercise the
 * LLM-touching POST endpoints (those need an agent-factory injection seam).
 */
const config: ResolvedPixiesConfig = {
	model: "anthropic/claude-3-5-sonnet",
	apiKey: "test-key",
	contactEmail: undefined,
	overpassUrl: "https://overpass-api.de/api/interpreter",
	nominatimUrl: "https://nominatim.openstreetmap.org",
	userAgent: "Pixies (test)",
	host: "127.0.0.1",
	port: 0,
	thinkingLevel: "off",
	dbFile: ":memory:",
	cacheSize: 50,
	httpRateLimit: 30,
	httpRateLimitWindowMs: 60_000,
	trustProxy: false,
	trustedProxyHops: 1,
	nominatimConcurrency: 1,
	nominatimIntervalCap: 1,
	nominatimIntervalMs: 1100,
	nominatimCacheTtlMs: 86_400_000,
	nominatimCacheMaxEntries: 1000,
	nominatimTimeoutMs: 60_000,
	overpassConcurrency: 2,
	overpassIntervalCap: 2,
	overpassIntervalMs: 1000,
	overpassTimeoutMs: 60_000,
	posthogHost: "https://eu.i.posthog.com",
	conversationTokenBudget: 0,
	maxPromptChars: 20000,
};

const instance: ServerInstance = startServer({
	config,
	logger: silentLogger,
	host: "127.0.0.1",
	port: 0,
});

afterAll(() => instance.stop());

test("startServer boots and serves /health regardless of cwd", async () => {
	const base = `http://localhost:${instance.server.port}`;
	const res = await fetch(`${base}/health`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toEqual({ status: "ok", conversations: 0 });
});

/**
 * Pins the `opts.serverConfig` injection seam (ADR-0011): an explicit
 * `serverConfig` must override `readServerConfigFromEnv()`, the way `opts.config`
 * overrides `readConfigFromEnv()`. The default `migrationsFolder` is reused so
 * `migrate()` still finds the repo's drizzle metadata; `webDist` is pointed at a
 * temp fixture whose `index.html` carries a marker. If the override did not flow
 * through, `/` would fall through to the default dist (404 here) instead of
 * serving the marker — proving `serverConfig.webDist` reaches the static handler.
 */
test("opts.serverConfig overrides readServerConfigFromEnv and flows to the static handler", async () => {
	const tempWebDist = fs.mkdtempSync(path.join(os.tmpdir(), "pixies-webdist-"));
	fs.writeFileSync(path.join(tempWebDist, "index.html"), "<h1>override-webdist</h1>");
	const override = startServer({
		config,
		serverConfig: { ...readServerConfigFromEnv(), webDist: tempWebDist },
		logger: silentLogger,
		host: "127.0.0.1",
		port: 0,
	});
	try {
		const base = `http://localhost:${override.server.port}`;
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<h1>override-webdist</h1>");
	} finally {
		override.stop();
		fs.rmSync(tempWebDist, { recursive: true, force: true });
	}
});
