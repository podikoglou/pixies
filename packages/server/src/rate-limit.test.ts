/// <reference types="bun" />
import { afterEach, expect, mock, test } from "bun:test";
import type { Logger } from "@pixies/core/logging";
import {
	IpRateLimiter,
	getClientIp,
	rateLimitResponse,
	checkRateLimit,
	type IpRateLimiterOptions,
} from "./rate-limit.ts";

/** Minimal Bun.Server stand-in exposing only `requestIP`. */
function fakeServer(address: string | null) {
	return {
		requestIP: () => (address ? { address, family: "IPv4", port: 1 } : null),
	} as unknown as Parameters<typeof getClientIp>[1];
}

// Every IpRateLimiter owns a live `setInterval` (the sweep loop). Track them
// so afterEach can tear the intervals down — mirrors the ConversationStore
// test-cleanup pattern (conversations.test.ts). Without this, intervals leak
// across tests and can fire spuriously.
const limiters: IpRateLimiter[] = [];

function makeLimiter(opts: IpRateLimiterOptions): IpRateLimiter {
	const limiter = new IpRateLimiter(opts);
	limiters.push(limiter);
	return limiter;
}

afterEach(() => {
	while (limiters.length) limiters.pop()?.stop();
});

// ---- IpRateLimiter.consume --------------------------------------------------

test("consume: allows up to maxRequests then denies with retryAfterMs", () => {
	const limiter = makeLimiter({
		maxRequests: 2,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	const t0 = 10_000;
	expect(limiter.consume("1.2.3.4", t0)).toEqual({ allowed: true, retryAfterMs: 0 });
	expect(limiter.consume("1.2.3.4", t0)).toEqual({ allowed: true, retryAfterMs: 0 });

	const denied = limiter.consume("1.2.3.4", t0);
	expect(denied.allowed).toBe(false);
	// Window started at t0 (first request); resets at t0 + windowMs.
	expect(denied.retryAfterMs).toBe(1000);
});

test("consume: window resets after windowMs", () => {
	const limiter = makeLimiter({
		maxRequests: 1,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	const t0 = 5_000;
	expect(limiter.consume("1.2.3.4", t0).allowed).toBe(true);
	expect(limiter.consume("1.2.3.4", t0).allowed).toBe(false);
	// After the window elapses, a fresh window starts.
	expect(limiter.consume("1.2.3.4", t0 + 1000).allowed).toBe(true);
});

test("consume: each IP has an independent window", () => {
	const limiter = makeLimiter({
		maxRequests: 1,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	expect(limiter.consume("1.1.1.1", 0).allowed).toBe(true);
	expect(limiter.consume("2.2.2.2", 0).allowed).toBe(true);
	expect(limiter.consume("1.1.1.1", 0).allowed).toBe(false);
	expect(limiter.consume("2.2.2.2", 0).allowed).toBe(false);
});

test("consume: denied warning never carries the client IP", () => {
	// Privacy contract (#222): the IP must not leave the instance via
	// PostHog Logs. It already keys the `rate limit exceeded` analytics event
	// (distinct id = ip), so logging it here only duplicates it as a free-text
	// property the sink does not redact. Pinned so a future fields edit can't
	// silently reintroduce it.
	const warning = mock((_msg?: string, _fields?: Record<string, unknown>) => {});
	const logger = { warning } as unknown as Logger;
	const limiter = makeLimiter({
		maxRequests: 1,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
		logger,
	});
	limiter.consume("203.0.113.7", 0); // allowed
	limiter.consume("203.0.113.7", 0); // denied → warning
	expect(warning).toHaveBeenCalledTimes(1);
	const [msg, fields] = warning.mock.calls[0]!;
	expect(msg).toBe("rate limit denied");
	expect(fields).not.toHaveProperty("ip");
});

test("consume: maxRequests <= 0 disables limiting", () => {
	const limiter = makeLimiter({
		maxRequests: 0,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	for (let i = 0; i < 5; i++) {
		expect(limiter.consume("1.1.1.1", 0).allowed).toBe(true);
	}
});

// ---- getClientIp ------------------------------------------------------------

test("getClientIp: direct peer when trustProxy is false (ignores XFF)", () => {
	const server = fakeServer("127.0.0.1");
	const req = new Request("https://x.example/", {
		headers: { "x-forwarded-for": "9.9.9.9" },
	});
	expect(getClientIp(req, server, false, 1)).toBe("127.0.0.1");
});

test("getClientIp: entry before rightmost trusted hop when trustProxy is true", () => {
	const server = fakeServer("127.0.0.1");
	// Caddy appends client IP to the right: [attacker-spoofed, real-client, caddy-hop]
	// With trustedProxyHops=1, the entry before the rightmost (caddy-hop) is real-client.
	const req = new Request("https://x.example/", {
		headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9, 10.0.0.1" },
	});
	expect(getClientIp(req, server, true, 1)).toBe("9.9.9.9");
});

test("getClientIp: handles multiple trusted hops", () => {
	const server = fakeServer("127.0.0.1");
	// attacker-spoofed, real-client, proxy1, proxy2
	const req = new Request("https://x.example/", {
		headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9, 10.0.0.1, 10.0.0.2" },
	});
	expect(getClientIp(req, server, true, 2)).toBe("9.9.9.9");
});

test("getClientIp: falls back to requestIP when XFF has too few entries", () => {
	const server = fakeServer("127.0.0.1");
	// Only one entry but we expect 1 trusted hop + 1 client = at least 2 entries.
	const req = new Request("https://x.example/", {
		headers: { "x-forwarded-for": "10.0.0.1" },
	});
	expect(getClientIp(req, server, true, 1)).toBe("127.0.0.1");
});

test("getClientIp: returns null when the peer IP cannot be determined", () => {
	const server = fakeServer(null);
	const req = new Request("https://x.example/");
	expect(getClientIp(req, server, false, 1)).toBeNull();
});

// ---- rateLimitResponse ------------------------------------------------------

test("rateLimitResponse: 429 with integer Retry-After (seconds, min 1)", async () => {
	const res = rateLimitResponse(1500);
	expect(res.status).toBe(429);
	expect(res.headers.get("retry-after")).toBe("2"); // ceil(1500/1000)
	const body = await res.json();
	expect(body).toHaveProperty("error");

	const resMin = rateLimitResponse(1);
	expect(resMin.headers.get("retry-after")).toBe("1");
});

// ---- checkRateLimit ---------------------------------------------------------

test("checkRateLimit: returns null when under the limit", () => {
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	expect(checkRateLimit("1.2.3.4", limiter)).toBeNull();
});

test("checkRateLimit: returns 429 once over the limit", () => {
	const limiter = makeLimiter({
		maxRequests: 1,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	expect(checkRateLimit("1.2.3.4", limiter)).toBeNull(); // 1st allowed
	const denied = checkRateLimit("1.2.3.4", limiter);
	expect(denied).toBeInstanceOf(Response);
	expect(denied!.status).toBe(429);
});

// ---- sweep / stop ----------------------------------------------------------
//
// The sweep loop reaps per-IP windows once their fixed window elapses, so the
// `windows` Map cannot grow unboundedly with unique client IPs. Mirrors the
// ConversationStore TTL sweeper (conversations.ts).

test("sweep: evicts entries whose window has elapsed (>= boundary matches consume)", () => {
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	limiter.consume("1.1.1.1", 0);
	limiter.consume("2.2.2.2", 500);
	// At t=1000: 1.1.1.1 elapsed (1000-0 >= 1000), 2.2.2.2 still active (1000-500 < 1000).
	const result = limiter.sweep(1000);
	expect(result).toEqual({ evictedCount: 1, windowCount: 1 });
});

test("sweep: preserves entries within their active window", () => {
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	limiter.consume("3.3.3.3", 0);
	const result = limiter.sweep(500);
	expect(result).toEqual({ evictedCount: 0, windowCount: 1 });
});

test("sweep: returns { evictedCount, windowCount } counts accurately", () => {
	const limiter = makeLimiter({
		maxRequests: 10,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	limiter.consume("1.1.1.1", 0);
	limiter.consume("2.2.2.2", 0);
	limiter.consume("3.3.3.3", 0);
	limiter.consume("4.4.4.4", 800); // within window at t=1000 (1000-800=200 < 1000)
	const result = limiter.sweep(1000);
	expect(result.evictedCount).toBe(3);
	expect(result.windowCount).toBe(1);
});

test("sweep: is idempotent (consecutive sweeps on an idle map evict nothing)", () => {
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	limiter.consume("1.1.1.1", 0);
	limiter.consume("2.2.2.2", 100);
	// First sweep at t=1000 evicts only 1.1.1.1.
	expect(limiter.sweep(1000)).toEqual({ evictedCount: 1, windowCount: 1 });
	// Re-sweep at the same clock: 1.1.1.1 already gone, 2.2.2.2 still active.
	expect(limiter.sweep(1000)).toEqual({ evictedCount: 0, windowCount: 1 });
});

test("sweep: empty map is a no-op", () => {
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
	});
	expect(limiter.sweep(1_000_000)).toEqual({ evictedCount: 0, windowCount: 0 });
});

test("sweep: logs rate_limit_windows_cleaned with exact fields on non-zero eviction", () => {
	const info = mock((_msg?: string, _fields?: Record<string, unknown>) => {});
	const logger = { info } as unknown as Logger;
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
		logger,
	});
	limiter.consume("1.1.1.1", 0);
	limiter.sweep(1000);
	expect(info).toHaveBeenCalledWith("rate-limit windows cleaned", {
		evictedCount: 1,
		windowCount: 0,
		event: "rate_limit_windows_cleaned",
	});
});

test("sweep: does not log when nothing was evicted (avoid log spam)", () => {
	const info = mock((_msg?: string, _fields?: Record<string, unknown>) => {});
	const logger = { info } as unknown as Logger;
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 1000,
		trustProxy: false,
		trustedProxyHops: 1,
		logger,
	});
	limiter.consume("1.1.1.1", 0);
	limiter.sweep(500); // entry still within its window → no eviction
	expect(info).not.toHaveBeenCalled();
});

test("background interval calls sweep automatically", async () => {
	// bun:test cannot fast-forward `setInterval` (see conversations.ts sweep
	// comment), so this uses a short windowMs + real wall-clock wait to prove
	// the constructor's interval fires sweep without an explicit call.
	const info = mock((_msg?: string, _fields?: Record<string, unknown>) => {});
	const logger = { info } as unknown as Logger;
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 50,
		trustProxy: false,
		trustedProxyHops: 1,
		logger,
	});
	limiter.consume("1.1.1.1"); // windowStart = now
	// Wait long enough for >=2 interval ticks; the entry's window elapses at
	// +50ms, so at least one auto-sweep must evict it and emit the log.
	await new Promise((r) => setTimeout(r, 130));
	const cleanupCall = info.mock.calls.find((c) => c[1]?.event === "rate_limit_windows_cleaned");
	expect(cleanupCall).toBeDefined();
	expect(cleanupCall?.[1]?.evictedCount).toBeGreaterThanOrEqual(1);
});

test("stop: clears the interval (no further sweeps after stop)", async () => {
	const info = mock((_msg?: string, _fields?: Record<string, unknown>) => {});
	const logger = { info } as unknown as Logger;
	const limiter = makeLimiter({
		maxRequests: 5,
		windowMs: 50,
		trustProxy: false,
		trustedProxyHops: 1,
		logger,
	});
	limiter.stop();
	limiter.consume("1.1.1.1"); // would be evicted by an auto-sweep if the interval were live
	await new Promise((r) => setTimeout(r, 130));
	const cleanupCall = info.mock.calls.find((c) => c[1]?.event === "rate_limit_windows_cleaned");
	expect(cleanupCall).toBeUndefined();
});
