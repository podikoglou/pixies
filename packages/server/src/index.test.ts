/// <reference types="bun" />
import { afterAll, expect, test } from "bun:test";
import { type ResolvedPixiesConfig } from "@pixies/core";
import { silentLogger } from "@pixies/core/logging";
import { startServer } from "./index.ts";

/**
 * Regression for #97: `startServer` used to call
 * `migrate({ migrationsFolder: "./drizzle" })`, which is cwd-relative. The
 * `drizzle/` folder lives at the repo root, so booting the server from any
 * cwd other than the repo root (e.g. `bun test` from `packages/server`)
 * threw `Can't find meta/_journal.json file`. The folder is now resolved
 * via `import.meta.dir`, mirroring the `WEB_DIST` pattern.
 *
 * This test boots the real `startServer` from this package's directory and
 * hits `/health` — proving migrations ran. It does not exercise the
 * LLM-touching POST endpoints (those need an agent-factory injection seam,
 * tracked separately in #91 / #79).
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
	nominatimConcurrency: 1,
	nominatimIntervalCap: 1,
	nominatimIntervalMs: 1100,
	overpassConcurrency: 2,
	overpassIntervalCap: 2,
	overpassIntervalMs: 1000,
};

const server = startServer({ config, logger: silentLogger, hostname: "127.0.0.1", port: 0 });

afterAll(() => server.stop(true));

test("startServer boots and serves /health regardless of cwd (#97)", async () => {
	const base = `http://localhost:${server.port}`;
	const res = await fetch(`${base}/health`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toEqual({ status: "ok", conversations: 0 });
});
