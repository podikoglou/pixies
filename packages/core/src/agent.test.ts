/// <reference types="bun" />
import { afterEach, expect, mock, test } from "bun:test";
import { createOsmClients, readConfigFromEnv } from "./agent.ts";
import type { ResolvedPixiesConfig } from "./config-schema.ts";

/**
 * Env-backed config propagation and validation.
 *
 * Originally added in PR #98 for the 6 OSM rate-limit knobs (full pipeline:
 * `PIXIES_*` env vars → `readConfigFromEnv` → `createOsmClients` → per-client
 * p-queue limiter). Extended in #101/#103/#105 to cover the full numeric field
 * set, URL/email format validation, and the empty-as-unset rule (D3) that
 * prevents `PIXIES_HTTP_RATE_LIMIT=` from silently disabling rate limiting.
 * Defaults equal the public-instance policy.
 */

const OSM_RATE_ENV_KEYS = [
	"PIXIES_NOMINATIM_CONCURRENCY",
	"PIXIES_NOMINATIM_INTERVAL_CAP",
	"PIXIES_NOMINATIM_INTERVAL_MS",
	"PIXIES_OVERPASS_CONCURRENCY",
	"PIXIES_OVERPASS_INTERVAL_CAP",
	"PIXIES_OVERPASS_INTERVAL_MS",
] as const;

/** Non-OSM numeric env keys covered by #105. */
const NUMERIC_ENV_KEYS = [
	"PIXIES_PORT",
	"PIXIES_CACHE_SIZE",
	"PIXIES_HTTP_RATE_LIMIT",
	"PIXIES_HTTP_RATE_LIMIT_WINDOW_MS",
] as const;

/** URL/email env keys covered by #103 part 2. */
const URL_EMAIL_ENV_KEYS = [
	"PIXIES_OVERPASS_URL",
	"PIXIES_NOMINATIM_URL",
	"PIXIES_CONTACT_EMAIL",
] as const;

/** User-Agent env key (string default, covered by #108). */
const USER_AGENT_ENV_KEYS = ["PIXIES_USER_AGENT"] as const;

/** Keys readConfigFromEnv consults; snapshot/restore keeps tests hermetic. */
const SNAPSHOT_KEYS = [
	"PIXIES_MODEL",
	"PIXIES_API_KEY",
	...OSM_RATE_ENV_KEYS,
	...NUMERIC_ENV_KEYS,
	...URL_EMAIL_ENV_KEYS,
	...USER_AGENT_ENV_KEYS,
] as const;

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
function setEnv(overrides: Record<string, string> = {}) {
	process.env.PIXIES_MODEL = "anthropic/claude-3-5-sonnet";
	process.env.PIXIES_API_KEY = "test-key";
	for (const key of [
		...OSM_RATE_ENV_KEYS,
		...NUMERIC_ENV_KEYS,
		...URL_EMAIL_ENV_KEYS,
		...USER_AGENT_ENV_KEYS,
	]) {
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(overrides)) {
		process.env[key] = value;
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

test("readConfigFromEnv applies the descriptive default User-Agent when PIXIES_USER_AGENT is unset [#108]", () => {
	setEnv();
	delete process.env.PIXIES_USER_AGENT;
	const config = readConfigFromEnv();
	expect(config.userAgent).toBe("Pixies/1.0 (https://github.com/podikoglou/pixies)");
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

// ---- #101 + #105: invalid numeric values rejected at config time -------------

type NumericFieldSpec = {
	envKey: string;
	field: keyof ResolvedPixiesConfig;
	defaultValue: number;
	/** Schema min bound. `0` means the field permits a `0` disable sentinel. */
	min: number;
};

/**
 * Every numeric env var with its resolved config field, documented default, and
 * schema min bound. Drives the parametrized validation tests below so adding a
 * new numeric knob is a one-line change here.
 */
const NUMERIC_FIELD_SPECS: readonly NumericFieldSpec[] = [
	{ envKey: "PIXIES_PORT", field: "port", defaultValue: 3000, min: 1 },
	{ envKey: "PIXIES_CACHE_SIZE", field: "cacheSize", defaultValue: 50, min: 0 },
	{ envKey: "PIXIES_HTTP_RATE_LIMIT", field: "httpRateLimit", defaultValue: 30, min: 0 },
	{
		envKey: "PIXIES_HTTP_RATE_LIMIT_WINDOW_MS",
		field: "httpRateLimitWindowMs",
		defaultValue: 60_000,
		min: 1,
	},
	{
		envKey: "PIXIES_NOMINATIM_CONCURRENCY",
		field: "nominatimConcurrency",
		defaultValue: 1,
		min: 1,
	},
	{
		envKey: "PIXIES_NOMINATIM_INTERVAL_CAP",
		field: "nominatimIntervalCap",
		defaultValue: 1,
		min: 1,
	},
	{
		envKey: "PIXIES_NOMINATIM_INTERVAL_MS",
		field: "nominatimIntervalMs",
		defaultValue: 1100,
		min: 1,
	},
	{ envKey: "PIXIES_OVERPASS_CONCURRENCY", field: "overpassConcurrency", defaultValue: 2, min: 1 },
	{ envKey: "PIXIES_OVERPASS_INTERVAL_CAP", field: "overpassIntervalCap", defaultValue: 2, min: 1 },
	{
		envKey: "PIXIES_OVERPASS_INTERVAL_MS",
		field: "overpassIntervalMs",
		defaultValue: 1000,
		min: 1,
	},
];

for (const spec of NUMERIC_FIELD_SPECS) {
	test(`${spec.envKey}="foo" is rejected at config time (NaN never reaches p-queue / Bun.serve) [#101/#105]`, () => {
		setEnv({ [spec.envKey]: "foo" });
		expect(() => readConfigFromEnv()).toThrow();
	});

	test(`${spec.envKey}="3.5" is rejected at config time (must be an integer) [#101/#105]`, () => {
		setEnv({ [spec.envKey]: "3.5" });
		expect(() => readConfigFromEnv()).toThrow();
	});

	test(`${spec.envKey}="${spec.min - 1}" is rejected at config time (below min ${spec.min}) [#101/#105]`, () => {
		setEnv({ [spec.envKey]: String(spec.min - 1) });
		expect(() => readConfigFromEnv()).toThrow();
	});

	if (spec.min >= 1) {
		test(`${spec.envKey}="0" is rejected at config time (below min ${spec.min}; would crash p-queue) [#101]`, () => {
			setEnv({ [spec.envKey]: "0" });
			expect(() => readConfigFromEnv()).toThrow();
		});
	} else {
		// min === 0: "0" is a deliberate sentinel (cacheSize disable, httpRateLimit disable).
		test(`${spec.envKey}="0" resolves to 0 (min 0 honors the documented disable sentinel) [#105]`, () => {
			setEnv({ [spec.envKey]: "0" });
			expect(readConfigFromEnv()[spec.field]).toBe(0);
		});
	}

	// D3: empty string is treated as unset → schema default applies (NOT 0/NaN).
	// For httpRateLimit this is the security-critical assertion that an empty
	// value does NOT silently disable rate limiting.
	test(`${spec.envKey}="" resolves to default ${spec.defaultValue} (empty-as-unset, D3) [#101/#105]`, () => {
		setEnv({ [spec.envKey]: "" });
		expect(readConfigFromEnv()[spec.field]).toBe(spec.defaultValue);
	});
}

test('PIXIES_PORT="70000" is rejected at config time (above max 65535) [#105]', () => {
	setEnv({ PIXIES_PORT: "70000" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_HTTP_RATE_LIMIT="" does NOT silently disable rate limiting (resolves to default 30) [D3 security, #105]', () => {
	setEnv({ PIXIES_HTTP_RATE_LIMIT: "" });
	expect(readConfigFromEnv().httpRateLimit).toBe(30);
});

test('PIXIES_HTTP_RATE_LIMIT="0" explicitly disables rate limiting (sentinel honored) [#105]', () => {
	setEnv({ PIXIES_HTTP_RATE_LIMIT: "0" });
	expect(readConfigFromEnv().httpRateLimit).toBe(0);
});

// ---- #103 part 2: URL/email format validation at config time -----------------

test('PIXIES_OVERPASS_URL="not-a-url" is rejected at config time [#103]', () => {
	setEnv({ PIXIES_OVERPASS_URL: "not-a-url" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_NOMINATIM_URL="not-a-url" is rejected at config time [#103]', () => {
	setEnv({ PIXIES_NOMINATIM_URL: "not-a-url" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_CONTACT_EMAIL="not-an-email" is rejected at config time [#103]', () => {
	setEnv({ PIXIES_CONTACT_EMAIL: "not-an-email" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_OVERPASS_URL="" resolves to the default URL (empty-as-unset, D3) [#103]', () => {
	setEnv({ PIXIES_OVERPASS_URL: "" });
	expect(readConfigFromEnv().overpassUrl).toBe("https://overpass-api.de/api/interpreter");
});

test('PIXIES_CONTACT_EMAIL="" resolves to undefined (empty-as-unset, D3) [#103]', () => {
	setEnv({ PIXIES_CONTACT_EMAIL: "" });
	expect(readConfigFromEnv().contactEmail).toBeUndefined();
});
