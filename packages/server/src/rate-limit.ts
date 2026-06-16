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

export interface IpRateLimiterOptions {
	/** Max requests per IP per window. `<= 0` disables limiting. */
	maxRequests: number;
	/** Window length in ms. */
	windowMs: number;
	/** When true, prefer the first `X-Forwarded-For` entry (set behind Caddy/Nginx). */
	trustProxy: boolean;
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
	private readonly windows = new Map<string, WindowState>();

	constructor(opts: IpRateLimiterOptions) {
		this.maxRequests = opts.maxRequests;
		this.windowMs = opts.windowMs;
		this.trustProxy = opts.trustProxy;
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
			return { allowed: false, retryAfterMs: Math.max(1, state.windowStart + this.windowMs - now) };
		}
		return { allowed: true, retryAfterMs: 0 };
	}
}

/**
 * Resolve the client IP for a request.
 *
 * With `trustProxy`, prefer the first `X-Forwarded-For` entry (Caddy sets XFF
 * by default). Otherwise use the direct peer via `server.requestIP`. Returns
 * `null` if no IP can be determined (unix socket / closed connection).
 */
export function getClientIp(
	req: Request,
	server: { requestIP: (req: Request) => { address: string } | null },
	trustProxy: boolean,
): string | null {
	if (trustProxy) {
		const xff = req.headers.get("x-forwarded-for");
		if (xff) {
			const first = xff.split(",")[0]?.trim();
			if (first) return first;
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
	const ip = getClientIp(req, server, limiter.trustProxy);
	if (!ip) {
		console.warn("[rate-limit] could not determine client IP; allowing request");
		return null;
	}
	const { allowed, retryAfterMs } = limiter.consume(ip);
	return allowed ? null : rateLimitResponse(retryAfterMs);
}
