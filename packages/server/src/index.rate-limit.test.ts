/// <reference types="bun" />
import { test, expect } from "bun:test";
import { IpRateLimiter, checkRateLimit } from "./rate-limit.ts";

/**
 * HTTP-level integration test for the per-IP rate limit.
 *
 * Mirrors the wiring in `index.ts`: one shared `IpRateLimiter`, with each POST
 * handler calling `checkRateLimit` at the top and returning the `429` on deny.
 * `startServer` itself can't be exercised in-process because its
 * `migrate({ migrationsFolder: "./drizzle" })` is cwd-relative (the folder
 * lives at the repo root, not under `packages/server`) — tracked in #97.
 * This replica validates the real HTTP path: `server.requestIP` → `429` +
 * integer `Retry-After`, shared across both LLM-cost POST endpoints.
 */
test("POST /conversations and /conversations/:id/messages return 429 once the per-IP limit is exceeded", async () => {
	const limiter = new IpRateLimiter({ maxRequests: 2, windowMs: 60_000, trustProxy: false });
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const isCostPost =
				req.method === "POST" &&
				(url.pathname === "/conversations" || url.pathname.startsWith("/conversations/"));
			if (isCostPost) {
				const denied = checkRateLimit(req, srv, limiter);
				if (denied) return denied;
				return new Response("ok", { status: 200 });
			}
			return new Response("not found", { status: 404 });
		},
	});

	try {
		const base = `http://localhost:${server.port}`;
		// Two allowed (one per endpoint — same source IP shares the window).
		const r1 = await fetch(`${base}/conversations`, { method: "POST", body: "x" });
		const r2 = await fetch(`${base}/conversations/abc/messages`, { method: "POST", body: "x" });
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		// Over the limit → both endpoint shapes return 429 + Retry-After.
		const r3 = await fetch(`${base}/conversations`, { method: "POST", body: "x" });
		const r4 = await fetch(`${base}/conversations/abc/messages`, { method: "POST", body: "x" });
		expect(r3.status).toBe(429);
		expect(r4.status).toBe(429);
		expect(r3.headers.get("retry-after")).toMatch(/^\d+$/);
		expect(r4.headers.get("retry-after")).toMatch(/^\d+$/);
	} finally {
		server.stop(true);
	}
});
