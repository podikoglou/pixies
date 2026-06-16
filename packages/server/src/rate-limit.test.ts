/// <reference types="bun" />
import { test, expect, mock } from "bun:test";
import { type Logger } from "@pixies/core/logging";
import { IpRateLimiter, getClientIp, rateLimitResponse, checkRateLimit } from "./rate-limit.ts";

/** Minimal Bun.Server stand-in exposing only `requestIP`. */
function fakeServer(address: string | null) {
	return {
		requestIP: () => (address ? { address, family: "IPv4", port: 1 } : null),
	} as unknown as Parameters<typeof getClientIp>[1];
}

/** A Logger stub capturing only `warn` calls for assertion. */
function warnLogger() {
	const warn = mock((_obj: unknown, _msg?: string) => {});
	return { warn, logger: { warn } as unknown as Logger };
}

// ---- IpRateLimiter.consume --------------------------------------------------

test("consume: allows up to maxRequests then denies with retryAfterMs", () => {
	const limiter = new IpRateLimiter({ maxRequests: 2, windowMs: 1000, trustProxy: false });
	const t0 = 10_000;
	expect(limiter.consume("1.2.3.4", t0)).toEqual({ allowed: true, retryAfterMs: 0 });
	expect(limiter.consume("1.2.3.4", t0)).toEqual({ allowed: true, retryAfterMs: 0 });

	const denied = limiter.consume("1.2.3.4", t0);
	expect(denied.allowed).toBe(false);
	// Window started at t0 (first request); resets at t0 + windowMs.
	expect(denied.retryAfterMs).toBe(1000);
});

test("consume: window resets after windowMs", () => {
	const limiter = new IpRateLimiter({ maxRequests: 1, windowMs: 1000, trustProxy: false });
	const t0 = 5_000;
	expect(limiter.consume("1.2.3.4", t0).allowed).toBe(true);
	expect(limiter.consume("1.2.3.4", t0).allowed).toBe(false);
	// After the window elapses, a fresh window starts.
	expect(limiter.consume("1.2.3.4", t0 + 1000).allowed).toBe(true);
});

test("consume: each IP has an independent window", () => {
	const limiter = new IpRateLimiter({ maxRequests: 1, windowMs: 1000, trustProxy: false });
	expect(limiter.consume("1.1.1.1", 0).allowed).toBe(true);
	expect(limiter.consume("2.2.2.2", 0).allowed).toBe(true);
	expect(limiter.consume("1.1.1.1", 0).allowed).toBe(false);
	expect(limiter.consume("2.2.2.2", 0).allowed).toBe(false);
});

test("consume: maxRequests <= 0 disables limiting", () => {
	const limiter = new IpRateLimiter({ maxRequests: 0, windowMs: 1000, trustProxy: false });
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
	expect(getClientIp(req, server, false)).toBe("127.0.0.1");
});

test("getClientIp: first X-Forwarded-For entry when trustProxy is true", () => {
	const server = fakeServer("127.0.0.1");
	const req = new Request("https://x.example/", {
		headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
	});
	expect(getClientIp(req, server, true)).toBe("9.9.9.9");
});

test("getClientIp: falls back to requestIP when XFF is absent (trustProxy true)", () => {
	const server = fakeServer("127.0.0.1");
	const req = new Request("https://x.example/");
	expect(getClientIp(req, server, true)).toBe("127.0.0.1");
});

test("getClientIp: returns null when the peer IP cannot be determined", () => {
	const server = fakeServer(null);
	const req = new Request("https://x.example/");
	expect(getClientIp(req, server, false)).toBeNull();
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
	const server = fakeServer("1.2.3.4");
	const req = new Request("https://x.example/", { method: "POST" });
	const limiter = new IpRateLimiter({ maxRequests: 5, windowMs: 1000, trustProxy: false });
	expect(checkRateLimit(req, server, limiter)).toBeNull();
});

test("checkRateLimit: returns 429 once over the limit", () => {
	const server = fakeServer("1.2.3.4");
	const req = new Request("https://x.example/", { method: "POST" });
	const limiter = new IpRateLimiter({ maxRequests: 1, windowMs: 1000, trustProxy: false });
	expect(checkRateLimit(req, server, limiter)).toBeNull(); // 1st allowed
	const denied = checkRateLimit(req, server, limiter);
	expect(denied).toBeInstanceOf(Response);
	expect(denied!.status).toBe(429);
});

test("checkRateLimit: warns with diagnostic fields when a request is denied", () => {
	const { warn, logger } = warnLogger();
	const server = fakeServer("1.2.3.4");
	const req = new Request("https://x.example/", { method: "POST" });
	const limiter = new IpRateLimiter({ maxRequests: 1, windowMs: 1000, trustProxy: false, logger });
	expect(checkRateLimit(req, server, limiter)).toBeNull(); // allowed (count 1)
	const denied = checkRateLimit(req, server, limiter);
	expect(denied).toBeInstanceOf(Response);
	expect(denied!.status).toBe(429);
	expect(warn).toHaveBeenCalledTimes(1);
	const [obj, msg] = warn.mock.calls[0]!;
	expect(msg).toBe("rate limit denied");
	expect(obj).toMatchObject({ ip: "1.2.3.4", requestCount: 2, maxRequests: 1 });
});

test("checkRateLimit: unknown IP is allowed and warns (null requestIP)", () => {
	const { warn, logger } = warnLogger();
	const server = fakeServer(null);
	const req = new Request("https://x.example/", { method: "POST" });
	const limiter = new IpRateLimiter({ maxRequests: 1, windowMs: 1000, trustProxy: false, logger });
	// Repeated requests with no resolvable IP must never be denied, and each
	// emits a no-IP warning so operators can spot a misconfigured proxy.
	expect(checkRateLimit(req, server, limiter)).toBeNull();
	expect(checkRateLimit(req, server, limiter)).toBeNull();
	expect(warn).toHaveBeenCalledTimes(2);
	expect(warn.mock.calls[0]![1]).toBe("could not determine client IP; allowing request");
	expect(warn.mock.calls[0]![0]).toMatchObject({ event: "rate_limit_no_ip" });
});
