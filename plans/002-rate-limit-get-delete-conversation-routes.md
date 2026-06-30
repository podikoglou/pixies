# Plan 002: Rate-limit the GET and DELETE /conversations/:id routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8268077..HEAD -- packages/server/src/index.ts packages/server/src/index.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of plan 001)
- **Category**: security
- **Planned at**: commit `8268077`, 2026-06-30
- **Issue**: not yet published (deferred until fix lands; repo is public and this is a security finding)

## Why this matters

Only the two POST routes (`/conversations`, `/conversations/:id/messages`) call
`checkRateLimit`. The `GET /conversations/:id` and `DELETE /conversations/:id`
handlers are wrapped in `withRequestLogging` only — no rate limiting, no access
control. On a public instance this means anyone holding a conversation id can
read its transcript or delete it, unthrottled. Conversation ids are uuidv7
(not trivially enumerable), so this plan does **not** claim to fix the
underlying anonymous-by-id access model — that is a separate, larger decision
called out in "Out of scope". What this plan does is close the rate-limit gap
so enumeration and abuse scripts hit the same per-IP wall the POST routes
already enforce.

## Current state

Files in play:

- `packages/server/src/index.ts` — the route definitions and the rate-limit
  wiring that the POST routes already use.
- `packages/server/src/index.test.ts` — boots the real server; add the
  regression test here.

Excerpts (confirm these match the live code before editing).

The POST routes get rate-limited inside `createStreamMessageHandler`
(`packages/server/src/index.ts:373-405`):
```ts
return async (req: BunRequest, server: Bun.Server<undefined>) => {
	const ip = getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops);
	const denied = checkRateLimit(ip, rateLimiter);
	if (denied) {
		captureRateLimitDenied(posthog, ip, rateLimitPath);
		return denied;
	}

	const parsed = await readMessage(req);
	...
};
```

The GET and DELETE handlers do NOT — `packages/server/src/index.ts:438-457`:
```ts
"/conversations/:id": {
	GET: withRequestLogging(logger, async (req) => {
		const id = req.params.id!;
		const conv = await store.get(id);
		...
	}),
	DELETE: withRequestLogging(logger, (req) => {
		const id = req.params.id!;
		const ok = store.delete(id);
		...
	}),
},
```

The existing wrapper these handlers already use — `withRequestLogging`
(`packages/server/src/index.ts:268-283`), the shape to mirror for a
`withRateLimit` helper:
```ts
function withRequestLogging<T extends string = string>(
	logger: Logger,
	handler: (req: BunRequest<T>, server: Bun.Server<undefined>) => Response | Promise<Response>,
): (req: BunRequest<T>, server: Bun.Server<undefined>) => Promise<Response> {
	return async (req, server) => {
		const start = Date.now();
		const res = await handler(req, server);
		logger.info("request", { ... });
		return res;
	};
}
```

The two functions to call, both already imported at `index.ts:27`:
- `getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops)`
  — `packages/server/src/rate-limit.ts:142-163`. Needs the `server` arg for
  `requestIP`, which the handler signature already receives.
- `checkRateLimit(ip, rateLimiter)` — `packages/server/src/rate-limit.ts:184-193`.
  Returns a `429` `Response` when denied, or `null` when allowed.

`rateLimiter`, `posthog`, and `logger` are all in scope inside `startServer`
(the routes object is defined within it).

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Install   | `bun install`                                        | exit 0              |
| Typecheck | `bun run typecheck`                                  | exit 0, no errors   |
| Lint      | `bun run lint`                                       | exit 0              |
| Format    | `bun run format`                                     | files formatted     |
| Format ck | `bun run format:check`                               | exit 0              |
| Tests     | `bun run --filter '@pixies/server' test`             | all pass            |

The project uses `bun` (verified against `package.json` / `CONTRIBUTING.md`).

## Suggested executor toolkit

- Read `packages/server/src/rate-limit.test.ts` and
  `packages/server/src/index.rate-limit.test.ts` before writing the test — they
  show the existing `IpRateLimiter` / `checkRateLimit` unit-test patterns and
  the `429` + `Retry-After` contract. Match their style.

## Scope

**In scope** (the only files you should modify):
- `packages/server/src/index.ts` — apply the rate-limit check to the GET and
  DELETE handlers under `"/conversations/:id"`.
- `packages/server/src/index.test.ts` — add a regression test proving GET/DELETE
  return `429` once the per-IP window is exhausted.

**Out of scope** (do NOT touch):
- **Ownership / access control.** GET currently returns the user-side
  transcript (user messages contain location queries) and DELETE removes any
  conversation by id, with no identity check. Adding ownership (e.g. a secret
  token issued at creation, checked on read/delete) changes the wire protocol
  and the web client, needs an ADR, and is a product decision — it is
  deliberately deferred. Record it as a follow-up; do not implement it here.
- The POST routes' rate limiting — already correct.
- The rate-limit module itself (`packages/server/src/rate-limit.ts`) — no
  behavioural change needed; reuse `checkRateLimit` / `getClientIp` as-is.
- The web client.

## Git workflow

- Branch: `advisor/002-rate-limit-get-delete`
- Commit per logical unit (enforcement; test). Conventional commits, matching
  `git log --oneline -10` — e.g.
  `feat(server): rate-limit GET/DELETE /conversations/:id`,
  `test(server): assert 429 on GET/DELETE over the per-IP window`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Apply the rate-limit check to GET and DELETE

Add a small helper next to `withRequestLogging` (mirroring its shape) that does
the IP resolution + `checkRateLimit` and short-circuits with the `429` response:

```ts
function withRateLimit<T extends string = string>(
	logger: Logger,
	rateLimiter: IpRateLimiter,
	rateLimitPath: string,
	posthog: PostHogAnalyticsClient | undefined,
	handler: (req: BunRequest<T>, server: Bun.Server<undefined>) => Response | Promise<Response>,
): (req: BunRequest<T>, server: Bun.Server<undefined>) => Promise<Response> {
	return async (req, server) => {
		const ip = getClientIp(req, server, rateLimiter.trustProxy, rateLimiter.trustedProxyHops);
		const denied = checkRateLimit(ip, rateLimiter);
		if (denied) {
			captureRateLimitDenied(posthog, ip, rateLimitPath);
			return denied;
		}
		return handler(req, server);
	};
}
```

Then wrap the GET and DELETE handlers so rate-limiting runs first, with
`withRequestLogging` outside it (so a denied request is still logged) or inside
(your choice — match whichever the POST routes effectively do; the POST routes
log via `withRequestLogging` around `createStreamMessageHandler`, which does the
rate check internally, so logging-wraps-rate-check is the established order).
The cleanest composition:

```ts
GET: withRequestLogging(
	logger,
	withRateLimit(logger, rateLimiter, "/conversations/:id", posthog, async (req) => {
		const id = req.params.id!;
		const conv = await store.get(id);
		...
	}),
),
```

Repeat for DELETE with `rateLimitPath: "/conversations/:id"` (DELETE).

Keep the existing handler bodies (the `store.get` / `store.delete` logic and
their 404 responses) unchanged.

**Verify**:
- `bun run typecheck` → exit 0.
- `bun run lint` → exit 0.

### Step 2: Add a regression test

In `packages/server/src/index.test.ts`. The existing top-level `instance`
boots with `httpRateLimit: 30`, which is too high to hit quickly. Boot a
second throwaway server with a tiny limit, mirroring the existing second-server
pattern at `index.test.ts:82-88`:

```ts
test("GET/DELETE /conversations/:id return 429 over the per-IP window", async () => {
	const limited = startServer({
		config: { ...config, httpRateLimit: 2 },
		logger: silentLogger,
		host: "127.0.0.1",
		port: 0,
	});
	try {
		const base = `http://localhost:${limited.server.port}`;
		const url = `${base}/conversations/does-not-exist`;
		// Two requests are allowed (window = 2); the third is denied.
		const r1 = await fetch(url);
		const r2 = await fetch(url);
		const r3 = await fetch(url);
		expect(r1.status).toBe(404); // nonexistent id, but under the limit
		expect(r2.status).toBe(404);
		expect(r3.status).toBe(429);
		expect(r3.headers.get("retry-after")).not.toBeNull();
		// Same for DELETE on a different path/verb.
		const d3 = await fetch(url, { method: "DELETE" });
		expect(d3.status).toBe(429);
	} finally {
		limited.stop();
	}
});
```

Notes for the executor:
- A nonexistent id returns 404 (see the GET/DELETE handler bodies) and is
  fine — the assertion is about the `429` from the limiter, not the 404. The
  point is to prove the limiter fires on these verbs at all.
- `instance.stop()` semantics: the throwaway server is stopped in `finally`,
  mirroring `index.test.ts:95`.
- All requests come from the same loopback IP (`127.0.0.1`), and the test
  config sets `trustProxy: false`, so they share one per-IP window — which is
  exactly what makes the third request deny.

**Verify**: `bun run --filter '@pixies/server' test` → all pass, including the
new test.

## Test plan

- New test (Step 2): GET and DELETE on `/conversations/:id` return `429` (with
  `Retry-After`) once the per-IP window is exhausted; earlier requests are
  allowed through to the handler (404 for a nonexistent id).
- Pattern source for booting a second configured server:
  `packages/server/src/index.test.ts:82-97`. Pattern source for the rate-limit
  contract (`429` + `Retry-After`): `packages/server/src/rate-limit.test.ts`
  and `packages/server/src/rate-limit.ts:166-172`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] `bun run --filter '@pixies/server' test` exits 0; the new 429 test exists and passes
- [ ] `grep -n "checkRateLimit" packages/server/src/index.ts` returns matches for GET/DELETE (not only the POST handler)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift since
  `8268077`).
- `checkRateLimit` or `getClientIp` signatures differ from what's quoted above
  (they live in `packages/server/src/rate-limit.ts:142-193`).
- The test cannot get a deterministic 429 because requests do NOT share a
  per-IP window under `trustProxy: false` on loopback (they should — verify by
  reading `checkRateLimit` + `getClientIp`; if loopback is somehow excluded,
  report rather than fudge the assertion).
- Applying the wrapper changes the response shape of the existing GET/DELETE
  happy paths (it must not — the wrapper only adds a pre-check).

## Maintenance notes

For whoever owns this after it lands:

- The GET and DELETE routes now share the **same** per-IP limiter as the POST
  routes (one window per IP across all verbs). If a future change splits
  limiters (e.g. a cheaper limit for reads), revisit `withRateLimit`.
- **The ownership gap remains.** This plan only adds throttling. The real fix
  for "anyone with an id reads/deletes any conversation" is an access-control
  model (secret token at creation, checked on read/delete) — a protocol-level
  change that needs its own plan + an ADR + web-client changes. File that
  follow-up; do not assume this plan closed it.
- A reviewer should check that a denied 429 is still request-logged (the
  `withRequestLogging` wrapper should sit outside `withRateLimit` so the deny is
  observable), and that `captureRateLimitDenied` fires for GET/DELETE too
  (analytics parity with the POST routes).
- Related: plan 001 (prompt-length cap) is independent and can land in either
  order.
