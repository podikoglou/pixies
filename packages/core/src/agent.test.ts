/// <reference types="bun" />
import { afterEach, expect, mock, test } from "bun:test";
import { ParseError } from "typebox/value";
import {
	classifyToolError,
	createNominatimClient,
	createOverpassClient,
	MAX_TRANSIENT_RETRIES,
	readConfigFromEnv,
	retryDirectiveFor,
} from "./agent.ts";
import { OVERPASS_BUSY_MESSAGE } from "./clients/overpass.ts";
import type { ResolvedPixiesConfig } from "./config-schema.ts";

/**
 * Env-backed config propagation and validation.
 *
 * Originally added for the 6 OSM rate-limit knobs (full pipeline:
 * `PIXIES_*` env vars → `readConfigFromEnv` → per-service factory →
 * per-client p-queue limiter). Extended to cover the full numeric field
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

/** Non-OSM numeric env keys. */
const NUMERIC_ENV_KEYS = [
	"PIXIES_PORT",
	"PIXIES_CACHE_SIZE",
	"PIXIES_HTTP_RATE_LIMIT",
	"PIXIES_HTTP_RATE_LIMIT_WINDOW_MS",
] as const;

/** Nominatim response-cache env keys. */
const NOMINATIM_CACHE_ENV_KEYS = [
	"PIXIES_NOMINATIM_CACHE_TTL_MS",
	"PIXIES_NOMINATIM_CACHE_MAX_ENTRIES",
] as const;

/** URL/email env keys. */
const URL_EMAIL_ENV_KEYS = [
	"PIXIES_OVERPASS_URL",
	"PIXIES_NOMINATIM_URL",
	"PIXIES_CONTACT_EMAIL",
] as const;

/** User-Agent env key (string default). */
const USER_AGENT_ENV_KEYS = ["PIXIES_USER_AGENT"] as const;

/** PostHog server-log shipping keys (optional host URL + token). */
const POSTHOG_ENV_KEYS = ["PIXIES_POSTHOG_HOST", "PIXIES_POSTHOG_API_KEY"] as const;

/** Keys readConfigFromEnv consults; snapshot/restore keeps tests hermetic. */
const SNAPSHOT_KEYS = [
	"PIXIES_MODEL",
	"PIXIES_API_KEY",
	...OSM_RATE_ENV_KEYS,
	...NOMINATIM_CACHE_ENV_KEYS,
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
		...NOMINATIM_CACHE_ENV_KEYS,
		...NUMERIC_ENV_KEYS,
		...URL_EMAIL_ENV_KEYS,
		...USER_AGENT_ENV_KEYS,
		...POSTHOG_ENV_KEYS,
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
	expect(config.nominatimCacheTtlMs).toBe(86_400_000);
	expect(config.nominatimCacheMaxEntries).toBe(1000);
	expect(config.nominatimTimeoutMs).toBe(5_000);
	expect(config.overpassConcurrency).toBe(2);
	expect(config.overpassIntervalCap).toBe(2);
	expect(config.overpassIntervalMs).toBe(1000);
	expect(config.overpassTimeoutMs).toBe(10_000);
});

test("readConfigFromEnv applies the descriptive default User-Agent when PIXIES_USER_AGENT is unset", () => {
	setEnv();
	delete process.env.PIXIES_USER_AGENT;
	const config = readConfigFromEnv();
	expect(config.userAgent).toBe("Pixies/1.0 (https://github.com/podikoglou/pixies)");
});

test("readConfigFromEnv coerces the 10 OSM env vars with Number()", () => {
	setEnv({
		PIXIES_NOMINATIM_CONCURRENCY: "5",
		PIXIES_NOMINATIM_INTERVAL_CAP: "4",
		PIXIES_NOMINATIM_INTERVAL_MS: "250",
		PIXIES_NOMINATIM_CACHE_TTL_MS: "3600000",
		PIXIES_NOMINATIM_CACHE_MAX_ENTRIES: "500",
		PIXIES_NOMINATIM_TIMEOUT_MS: "8000",
		PIXIES_OVERPASS_CONCURRENCY: "8",
		PIXIES_OVERPASS_INTERVAL_CAP: "7",
		PIXIES_OVERPASS_INTERVAL_MS: "900",
		PIXIES_OVERPASS_TIMEOUT_MS: "45000",
	});
	const config = readConfigFromEnv();
	expect(config.nominatimConcurrency).toBe(5);
	expect(config.nominatimIntervalCap).toBe(4);
	expect(config.nominatimIntervalMs).toBe(250);
	expect(config.nominatimCacheTtlMs).toBe(3_600_000);
	expect(config.nominatimCacheMaxEntries).toBe(500);
	expect(config.nominatimTimeoutMs).toBe(8_000);
	expect(config.overpassConcurrency).toBe(8);
	expect(config.overpassIntervalCap).toBe(7);
	expect(config.overpassIntervalMs).toBe(900);
	expect(config.overpassTimeoutMs).toBe(45_000);
});

// ---- behavioral: smaller Nominatim intervalMs speeds up serialization --------

/** Build a JSON success `Response` the Nominatim client accepts. */
function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

test("a smaller PIXIES_NOMINATIM_INTERVAL_MS speeds up serialization through createNominatimClient", async () => {
	setEnv({ PIXIES_NOMINATIM_INTERVAL_MS: "40" });
	const config = readConfigFromEnv();

	const starts: number[] = [];
	const fetchMock = mock(() => {
		starts.push(Date.now());
		return Promise.resolve(jsonResponse([]));
	}) as unknown as typeof fetch;

	const nominatim = createNominatimClient(config, { fetch: fetchMock });

	await nominatim.search("Berlin");
	await nominatim.search("Vienna");

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

test("a higher PIXIES_OVERPASS_CONCURRENCY allows more parallel queries through createOverpassClient", async () => {
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

	const overpass = createOverpassClient(config, { fetch: fetchMock });

	const p1 = overpass.query("[out:json];node(1);out;");
	const p2 = overpass.query("[out:json];node(2);out;");
	const p3 = overpass.query("[out:json];node(3);out;");
	const p4 = overpass.query("[out:json];node(4);out;");

	await Promise.resolve();
	await Promise.resolve();
	// All four started: the concurrency=4 override took effect (default 2
	// would have capped this at 2 fetch calls).
	expect(fetchMock).toHaveBeenCalledTimes(4);

	for (const b of blockers) b.resolve(jsonResponse({ elements: [] }));
	await Promise.all([p1, p2, p3, p4]);
});

// ---- invalid numeric values rejected at config time -------------

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
	{
		envKey: "PIXIES_NOMINATIM_CACHE_TTL_MS",
		field: "nominatimCacheTtlMs",
		defaultValue: 86_400_000,
		min: 0,
	},
	{
		envKey: "PIXIES_NOMINATIM_CACHE_MAX_ENTRIES",
		field: "nominatimCacheMaxEntries",
		defaultValue: 1000,
		min: 0,
	},
	{
		envKey: "PIXIES_NOMINATIM_TIMEOUT_MS",
		field: "nominatimTimeoutMs",
		defaultValue: 5_000,
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
	{
		envKey: "PIXIES_OVERPASS_TIMEOUT_MS",
		field: "overpassTimeoutMs",
		defaultValue: 10_000,
		min: 1,
	},
	{ envKey: "PIXIES_MAX_PROMPT_CHARS", field: "maxPromptChars", defaultValue: 20000, min: 1 },
];

for (const spec of NUMERIC_FIELD_SPECS) {
	test(`${spec.envKey}="foo" is rejected at config time (NaN never reaches p-queue / Bun.serve)`, () => {
		setEnv({ [spec.envKey]: "foo" });
		expect(() => readConfigFromEnv()).toThrow();
	});

	test(`${spec.envKey}="3.5" is rejected at config time (must be an integer)`, () => {
		setEnv({ [spec.envKey]: "3.5" });
		expect(() => readConfigFromEnv()).toThrow();
	});

	test(`${spec.envKey}="${spec.min - 1}" is rejected at config time (below min ${spec.min})`, () => {
		setEnv({ [spec.envKey]: String(spec.min - 1) });
		expect(() => readConfigFromEnv()).toThrow();
	});

	if (spec.min >= 1) {
		test(`${spec.envKey}="0" is rejected at config time (below min ${spec.min}; would crash p-queue)`, () => {
			setEnv({ [spec.envKey]: "0" });
			expect(() => readConfigFromEnv()).toThrow();
		});
	} else {
		// min === 0: "0" is a deliberate sentinel (cacheSize disable, httpRateLimit disable).
		test(`${spec.envKey}="0" resolves to 0 (min 0 honors the documented disable sentinel)`, () => {
			setEnv({ [spec.envKey]: "0" });
			expect(readConfigFromEnv()[spec.field]).toBe(0);
		});
	}

	// D3: empty string is treated as unset → schema default applies (NOT 0/NaN).
	// For httpRateLimit this is the security-critical assertion that an empty
	// value does NOT silently disable rate limiting.
	test(`${spec.envKey}="" resolves to default ${spec.defaultValue} (empty-as-unset, D3)`, () => {
		setEnv({ [spec.envKey]: "" });
		expect(readConfigFromEnv()[spec.field]).toBe(spec.defaultValue);
	});
}

test('PIXIES_PORT="70000" is rejected at config time (above max 65535)', () => {
	setEnv({ PIXIES_PORT: "70000" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_HTTP_RATE_LIMIT="" does NOT silently disable rate limiting (resolves to default 30) [D3 security]', () => {
	setEnv({ PIXIES_HTTP_RATE_LIMIT: "" });
	expect(readConfigFromEnv().httpRateLimit).toBe(30);
});

test('PIXIES_HTTP_RATE_LIMIT="0" explicitly disables rate limiting (sentinel honored)', () => {
	setEnv({ PIXIES_HTTP_RATE_LIMIT: "0" });
	expect(readConfigFromEnv().httpRateLimit).toBe(0);
});

// ---- URL/email format validation at config time -----------------

test('PIXIES_OVERPASS_URL="not-a-url" is rejected at config time', () => {
	setEnv({ PIXIES_OVERPASS_URL: "not-a-url" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_NOMINATIM_URL="not-a-url" is rejected at config time', () => {
	setEnv({ PIXIES_NOMINATIM_URL: "not-a-url" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_CONTACT_EMAIL="not-an-email" is rejected at config time', () => {
	setEnv({ PIXIES_CONTACT_EMAIL: "not-an-email" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_OVERPASS_URL="" resolves to the default URL (empty-as-unset, D3)', () => {
	setEnv({ PIXIES_OVERPASS_URL: "" });
	expect(readConfigFromEnv().overpassUrl).toBe("https://overpass-api.de/api/interpreter");
});

test('PIXIES_CONTACT_EMAIL="" resolves to undefined (empty-as-unset, D3)', () => {
	setEnv({ PIXIES_CONTACT_EMAIL: "" });
	expect(readConfigFromEnv().contactEmail).toBeUndefined();
});

// ---- PostHog server-log shipping (host URL validated; key is the off-switch) -

test('PIXIES_POSTHOG_HOST="not-a-url" is rejected at config time', () => {
	setEnv({ PIXIES_POSTHOG_HOST: "not-a-url" });
	expect(() => readConfigFromEnv()).toThrow();
});

test('PIXIES_POSTHOG_HOST="" resolves to the default host (empty-as-unset, D3)', () => {
	setEnv({ PIXIES_POSTHOG_HOST: "" });
	expect(readConfigFromEnv().posthogHost).toBe("https://eu.i.posthog.com");
});

test("PIXIES_POSTHOG_API_KEY unset leaves log shipping off (posthogApiKey undefined)", () => {
	setEnv({});
	expect(readConfigFromEnv().posthogApiKey).toBeUndefined();
});

test("PIXIES_POSTHOG_API_KEY set reads the token", () => {
	setEnv({ PIXIES_POSTHOG_API_KEY: "phc-test-token" });
	expect(readConfigFromEnv().posthogApiKey).toBe("phc-test-token");
});

// ---- provider prefix validated against pi-ai's registry ---------

test('PIXIES_MODEL="notaprovider/some-model" is rejected at config time (unknown provider)', () => {
	setEnv({ PIXIES_MODEL: "notaprovider/some-model" });
	expect(() => readConfigFromEnv()).toThrow();
});

test("readConfigFromEnv surfaces the unknown-provider message with the valid-provider list", () => {
	setEnv({ PIXIES_MODEL: "notaprovider/some-model" });
	let caught: unknown;
	try {
		readConfigFromEnv();
		caught = undefined;
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ParseError);
	// TypeBox's Value.Parse throws a ParseError whose `.cause.errors` array
	// carries the structured validation issues. The Refine's error callback
	// names the bad provider AND lists valid ones, so operators can fix a
	// typo without grepping pi-ai.
	const issueMsg = (caught as ParseError).cause.errors[0]?.message ?? "";
	expect(issueMsg).toContain('Unknown provider "notaprovider"');
	expect(issueMsg).toContain("anthropic");
	expect(issueMsg).toContain("openai");
});

// ---- tool-error classification + retry directives (issue #277) --------------
//
// The agent used to give up after a single transient `network error:` from an
// OSM endpoint. classifyToolError / retryDirectiveFor are the pure helpers that
// drive the new retry directive; MAX_TRANSIENT_RETRIES bounds it per
// conversation. Tests cover the three kinds and the "busy signal must NOT be
// classified as transient" guardrail.

test('classifyToolError returns "transient" for the exact #277 RuntimeError string', () => {
	expect(classifyToolError("RuntimeError: network error: The operation timed out.")).toBe(
		"transient",
	);
});

test('classifyToolError returns "transient" for a bare "network error: fetch failed"', () => {
	expect(classifyToolError("network error: fetch failed")).toBe("transient");
});

test("classifyToolError is case-insensitive (NETWORK ERROR still transient)", () => {
	// The clients author lowercase `network error:` today, but the regex is /i
	// — pin that so a future change to the clients' wording stays classified.
	expect(classifyToolError("RuntimeError: NETWORK ERROR: fetch failed")).toBe("transient");
});

test('classifyToolError returns "coding" for a NameError', () => {
	expect(classifyToolError("NameError: name 'x' is not defined")).toBe("coding");
});

test('classifyToolError returns "coding" for a shape error', () => {
	expect(classifyToolError("result must be a list[Feature]")).toBe("coding");
});

test('classifyToolError returns "other" for the Overpass busy message (NOT transient)', () => {
	// The busy signal is explicitly non-retryable and textually distinct from
	// `network error:`. Classification must keep it in "other" so the agent
	// tells the user the service is down rather than retrying.
	expect(classifyToolError(OVERPASS_BUSY_MESSAGE)).toBe("other");
});

test('classifyToolError returns "other" for an unrelated string', () => {
	expect(classifyToolError("something else entirely")).toBe("other");
});

test('retryDirectiveFor("transient") says to retry the SAME call unchanged', () => {
	const directive = retryDirectiveFor("transient", "network error: timed out");
	expect(directive).not.toBeNull();
	expect(directive!.length).toBe(1);
	expect(directive![0]!.type).toBe("text");
	expect(directive![0]!.text).toContain("Retry the SAME call");
	// Original error text is appended so the model can see what failed.
	expect(directive![0]!.text).toContain("network error: timed out");
});

test('retryDirectiveFor("coding") starts with the "Your code produced a" preamble', () => {
	const directive = retryDirectiveFor("coding", "NameError: name 'x' is not defined");
	expect(directive).not.toBeNull();
	expect(directive![0]!.text.startsWith("Your code produced a")).toBe(true);
	expect(directive![0]!.text).toContain("NameError: name 'x' is not defined");
});

test('retryDirectiveFor("other") returns null (no directive injected)', () => {
	expect(retryDirectiveFor("other", OVERPASS_BUSY_MESSAGE)).toBeNull();
});

test("MAX_TRANSIENT_RETRIES is the documented budget of 2", () => {
	// Pinning the cap so a future change is deliberate and visible. Each
	// transient retry is one model turn (one fresh 5s execute_code cell);
	// 2 means up to 3 total attempts of the same call before give-up.
	expect(MAX_TRANSIENT_RETRIES).toBe(2);
});
