/// <reference types="bun" />
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readServerConfigFromEnv } from "./config.ts";

/**
 * `readServerConfigFromEnv` is the seam that brought `PIXIES_WEB_DIST` /
 * `PIXIES_MIGRATIONS_FOLDER` out of module-level `??` fallbacks and into a
 * TypeBox schema (issue #231). These tests pin its contract: the
 * `import.meta.dir`-relative defaults apply when unset, env vars override,
 * and empty/whitespace is treated as unset (mirroring core's `env()`).
 */
const KEYS = ["PIXIES_WEB_DIST", "PIXIES_MIGRATIONS_FOLDER"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test("readServerConfigFromEnv resolves import.meta.dir-relative defaults when the env vars are unset", () => {
	for (const k of KEYS) delete process.env[k];
	const config = readServerConfigFromEnv();
	expect(config.webDist).toBe(path.resolve(import.meta.dir, "../../web/dist"));
	expect(config.migrationsFolder).toBe(path.resolve(import.meta.dir, "../../../drizzle"));
});

test("readServerConfigFromEnv honors PIXIES_WEB_DIST / PIXIES_MIGRATIONS_FOLDER overrides", () => {
	process.env.PIXIES_WEB_DIST = "/custom/web";
	process.env.PIXIES_MIGRATIONS_FOLDER = "/custom/drizzle";
	const config = readServerConfigFromEnv();
	expect(config.webDist).toBe("/custom/web");
	expect(config.migrationsFolder).toBe("/custom/drizzle");
});

test("readServerConfigFromEnv treats an empty value as unset and applies the default", () => {
	process.env.PIXIES_WEB_DIST = "  ";
	process.env.PIXIES_MIGRATIONS_FOLDER = "";
	const config = readServerConfigFromEnv();
	expect(config.webDist).toBe(path.resolve(import.meta.dir, "../../web/dist"));
	expect(config.migrationsFolder).toBe(path.resolve(import.meta.dir, "../../../drizzle"));
});
