/**
 * In-process per-IP HTTP rate limiting for the two LLM-cost POST endpoints.
 *
 * Rationale (ADR-0004 scope): the server is a single process coordinating
 * conversations in memory, so an in-process limiter is sufficient and works
 * identically in dev and prod. Stock Caddy has no rate-limit plugin (needs an
 * `xcaddy` custom build), and the cost surface we guard is the LLM-triggering
 * endpoints, not static assets. Caddy-side limiting remains an optional
 * future defense-in-depth. See issue #91.
 */

import { silentLogger, type Logger } from "@pixies/core/logging";

export interface IpRateLimiterOptions {
	/** Max requests per IP per window. `<= 0` disables limiting. */
	maxRequests: number;
	/** Window length in ms. */
	windowMs: number;
	/** When true, parse `X-Forwarded-For` for the client IP (set behind Caddy/Nginx). */
	trustProxy: boolean;
	/**
	 * Number of trusted proxy hops (from the right of X-Forwarded-For).
	 * Only used when `trustProxy` is true. Default 1 for a single reverse proxy.
	 */
	trustedProxyHops: number;
	/** Structured logger; defaults to silent. */
	logger?: Logger;
}

interface WindowState {
	count: number;
	windowStart: number;
}

export interface ConsumeResult {
	allowed: boolean;
	/** ms until the current window resets (meaningful only when denied). */
	retryAfterMs: number;
}

/**
 * Fixed-window per-IP counter. Each IP gets a window `[windowStart,
 * windowStart + windowMs)`; the counter resets when the window elapses.
 */
export class IpRateLimiter {
	readonly maxRequests: number;
	readonly windowMs: number;
	readonly trustProxy: boolean;
	readonly trustedProxyHops: number;
	readonly logger: Logger;
	private readonly windows = new Map<string, WindowState>();

	constructor(opts: IpRateLimiterOptions) {
		this.maxRequests = opts.maxRequests;
		this.windowMs = opts.windowMs;
		this.trustProxy = opts.trustProxy;
		this.trustedProxyHops = opts.trustedProxyHops;
		this.logger = opts.logger ?? silentLogger;
	}

	/**
	 * Record a request from `ip`. Increments the counter; returns whether the
	 * request is allowed and, if denied, how long until the window resets.
	 */
	consume(ip: string, now: number = Date.now()): ConsumeResult {
		if (this.maxRequests <= 0) return { allowed: true, retryAfterMs: 0 };
		let state = this.windows.get(ip);
		if (!state || now - state.windowStart >= this.windowMs) {
			state = { count: 0, windowStart: now };
			this.windows.set(ip, state);
		}
		state.count++;
		if (state.count > this.maxRequests) {
			const retryAfterMs = Math.max(1, state.windowStart + this.windowMs - now);
			this.logger.warn(
				{ ip, requestCount: state.count, maxRequests: this.maxRequests, retryAfterMs },
				"rate limit denied",
			);
			return { allowed: false, retryAfterMs };
		}
		return { allowed: true, retryAfterMs: 0 };
	}
}

/**
 * Resolve the client IP for a request.
 *
 * When `trustProxy` is true, the rightmost `trustedProxyHops` entries of
 * `X-Forwarded-For` are treated as trusted proxies; the entry immediately
 * preceding them is the client IP. This prevents spoofing by ignoring
 * attacker-controlled leftmost entries.
 *
 * Without `trustProxy`, the direct peer IP from `server.requestIP` is used.
 * Returns `null` if no IP can be determined (unix socket / closed connection).
 */
export function getClientIp(
	req: Request,
	server: { requestIP: (req: Request) => { address: string } | null },
	trustProxy: boolean,
	trustedProxyHops: number,
): string | null {
	if (trustProxy) {
		const xff = req.headers.get("x-forwarded-for");
		if (xff) {
			const parts = xff
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const clientIdx = parts.length - trustedProxyHops - 1;
			if (clientIdx >= 0) {
				const clientIp = parts[clientIdx];
				if (clientIp) return clientIp;
			}
		}
	}
	return server.requestIP(req)?.address ?? null;
}

/** Build a `429 Too Many Requests` response with an integer `Retry-After` (s). */
export function rateLimitResponse(retryAfterMs: number): Response {
	const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
	return Response.json(
		{ error: "rate limit exceeded" },
		{ status: 429, headers: { "Retry-After": String(retryAfterSec) } },
	);
}

/**
 * Check a request against the limiter.
 *
 * Returns a `429` `Response` when the IP is over the limit, or `null` when the
 * request is allowed (including the unknown-IP case, which is allowed with a
 * warning rather than blocking legitimate requests).
 */
export function checkRateLimit(
	req: Request,
	server: { requestIP: (req: Request) => { address: string } | null },
	limiter: IpRateLimiter,
): Response | null {
	const ip = getClientIp(req, server, limiter.trustProxy, limiter.trustedProxyHops);
	if (!ip) {
		limiter.logger.warn(
			{ event: "rate_limit_no_ip" },
			"could not determine client IP; allowing request",
		);
		return null;
	}
	const { allowed, retryAfterMs } = limiter.consume(ip);
	return allowed ? null : rateLimitResponse(retryAfterMs);
}
