/// <reference types="bun" />
import { afterEach, expect, mock, test } from "bun:test";
import { createOsmClients, readConfigFromEnv } from "./agent.ts";

/**
 * Env-backed config propagation for the 6 OSM rate-limit knobs added in PR #98.
 * Asserts the full pipeline: `PIXIES_*` env vars → `readConfigFromEnv` →
 * `createOsmClients` → the per-client p-queue limiter behaves with the
 * configured concurrency/interval. Defaults equal the public-instance policy.
 */

const OSM_RATE_ENV_KEYS = [
	"PIXIES_NOMINATIM_CONCURRENCY",
	"PIXIES_NOMINATIM_INTERVAL_CAP",
	"PIXIES_NOMINATIM_INTERVAL_MS",
	"PIXIES_OVERPASS_CONCURRENCY",
	"PIXIES_OVERPASS_INTERVAL_CAP",
	"PIXIES_OVERPASS_INTERVAL_MS",
] as const;

/** Keys readConfigFromEnv consults; snapshot/restore keeps tests hermetic. */
const SNAPSHOT_KEYS = ["PIXIES_MODEL", "PIXIES_API_KEY", ...OSM_RATE_ENV_KEYS] as const;

const snapshot: Record<string, string | undefined> = {};

beforeEnvSnapshot();

function beforeEnvSnapshot() {
	for (const key of SNAPSHOT_KEYS) snapshot[key] = process.env[key];
}

afterEach(() => {
	for (const key of SNAPSHOT_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key];
	}
});

/** Set the required model/apiKey plus any overrides; clear the rest. */
function setEnv(overrides: Partial<Record<(typeof OSM_RATE_ENV_KEYS)[number], string>> = {}) {
	process.env.PIXIES_MODEL = "anthropic/claude-3-5-sonnet";
	process.env.PIXIES_API_KEY = "test-key";
	for (const key of OSM_RATE_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(overrides)) {
		process.env[key as string] = value;
	}
}

// ---- readConfigFromEnv parsing + defaults ------------------------------------

test("readConfigFromEnv applies the default-instance policy when OSM rate env vars are unset", () => {
	setEnv();
	const config = readConfigFromEnv();
	expect(config.nominatimConcurrency).toBe(1);
	expect(config.nominatimIntervalCap).toBe(1);
	expect(config.nominatimIntervalMs).toBe(1100);
	expect(config.overpassConcurrency).toBe(2);
	expect(config.overpassIntervalCap).toBe(2);
	expect(config.overpassIntervalMs).toBe(1000);
});

test("readConfigFromEnv coerces the 6 OSM rate env vars with Number()", () => {
	setEnv({
		PIXIES_NOMINATIM_CONCURRENCY: "5",
		PIXIES_NOMINATIM_INTERVAL_CAP: "4",
		PIXIES_NOMINATIM_INTERVAL_MS: "250",
		PIXIES_OVERPASS_CONCURRENCY: "8",
		PIXIES_OVERPASS_INTERVAL_CAP: "7",
		PIXIES_OVERPASS_INTERVAL_MS: "900",
	});
	const config = readConfigFromEnv();
	expect(config.nominatimConcurrency).toBe(5);
	expect(config.nominatimIntervalCap).toBe(4);
	expect(config.nominatimIntervalMs).toBe(250);
	expect(config.overpassConcurrency).toBe(8);
	expect(config.overpassIntervalCap).toBe(7);
	expect(config.overpassIntervalMs).toBe(900);
});

// ---- behavioral: smaller Nominatim intervalMs speeds up serialization --------

/** Build a JSON success `Response` osmFetch accepts. */
function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

test("a smaller PIXIES_NOMINATIM_INTERVAL_MS speeds up serialization through createOsmClients", async () => {
	setEnv({ PIXIES_NOMINATIM_INTERVAL_MS: "40" });
	const config = readConfigFromEnv();

	const starts: number[] = [];
	const fetchMock = mock(() => {
		starts.push(Date.now());
		return Promise.resolve(jsonResponse([]));
	}) as unknown as typeof fetch;

	const clients = createOsmClients({
		overpassUrl: "https://overpass.example.com/api/interpreter",
		nominatimUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		nominatimIntervalMs: config.nominatimIntervalMs,
		nominatimIntervalCap: config.nominatimIntervalCap,
		nominatimConcurrency: config.nominatimConcurrency,
	});

	await clients.nominatim.search("Berlin");
	await clients.nominatim.search("Vienna");

	expect(starts).toHaveLength(2);
	// The 40ms override took effect (not the 1100ms default): spacing is at
	// least ~38ms but well under a second.
	expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(38);
	expect(starts[1]! - starts[0]!).toBeLessThan(1000);
});

// ---- behavioral: higher Overpass concurrency allows more parallelism ---------

/** A deferred resolved manually to gate an in-flight fetch. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("a higher PIXIES_OVERPASS_CONCURRENCY allows more parallel queries through createOsmClients", async () => {
	// Default policy is 2/2/1000; override concurrency + intervalCap to 4 and
	// assert 4 run concurrently. (p-queue bounds starts per window by
	// intervalCap as well as concurrency, so both must rise to let 4 start in
	// the first window — with the defaults only 2 would start.)
	setEnv({
		PIXIES_OVERPASS_CONCURRENCY: "4",
		PIXIES_OVERPASS_INTERVAL_CAP: "4",
	});
	const config = readConfigFromEnv();

	const blockers: Deferred<Response>[] = [];
	const fetchMock = mock(() => {
		const d = deferred<Response>();
		blockers.push(d);
		return d.promise;
	}) as unknown as typeof fetch;

	const clients = createOsmClients({
		overpassUrl: "https://overpass.example.com/api/interpreter",
		nominatimUrl: "https://nominatim.example.com",
		userAgent: "pixies-test",
		fetch: fetchMock,
		overpassConcurrency: config.overpassConcurrency,
		overpassIntervalCap: config.overpassIntervalCap,
		overpassIntervalMs: config.overpassIntervalMs,
	});

	const p1 = clients.overpass.query("[out:json];node(1);out;");
	const p2 = clients.overpass.query("[out:json];node(2);out;");
	const p3 = clients.overpass.query("[out:json];node(3);out;");
	const p4 = clients.overpass.query("[out:json];node(4);out;");

	await Promise.resolve();
	await Promise.resolve();
	// All four started: the concurrency=4 override took effect (default 2
	// would have capped this at 2 fetch calls).
	expect(fetchMock).toHaveBeenCalledTimes(4);

	for (const b of blockers) b.resolve(jsonResponse({ elements: [] }));
	await Promise.all([p1, p2, p3, p4]);
});
