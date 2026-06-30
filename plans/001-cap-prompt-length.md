# Plan 001: Cap incoming prompt length to bound per-request LLM cost

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8268077..HEAD -- packages/server/src/index.ts packages/core/src/config-schema.ts packages/core/src/agent.ts packages/core/src/agent.test.ts packages/server/src/index.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `8268077`, 2026-06-30
- **Revised**: 2026-06-30 — first executor run STOPPED correctly: the original
  plan wrongly assumed a `PixiesConfigSchema` field auto-exposes its `PIXIES_*`
  env var. It does not — `readConfigFromEnv` (`agent.ts`) maps each knob by
  explicit name, so the env var would have been inert. Revised to wire the env
  var explicitly (Step 1 now touches `agent.ts` + `agent.test.ts`), which the
  first run had listed out of scope.
- **Issue**: not yet published (deferred until fix lands; repo is public and this is a security finding)

## Why this matters

The server accepts an unbounded `message` string and passes it straight to the
LLM agent. The only input validation is `minLength: 1`
(`packages/server/src/index.ts:84-86`). The conversation token budget that
*could* bound cost **defaults to `0` = unlimited**
(`packages/core/src/config-schema.ts:151-156`), so out of the box a single
multi-megabyte POST produces unbounded token spend and memory, and the per-IP
rate limiter counts *requests*, not *size*. Pixies runs a public instance
(pixies.aleep.lol), so this is reachable by anyone. Capping the prompt at the
HTTP boundary — before it reaches the agent — bounds the worst case per
request and gives the operator a tunable knob.

## Current state

Files in play:

- `packages/server/src/index.ts` — HTTP entry. Defines the request-body schema,
  the `readMessage` validator, and the `rejectMessageError` mapper.
- `packages/core/src/config-schema.ts` — TypeBox config schema; where the new
  `PIXIES_MAX_PROMPT_CHARS` knob is *declared*.
- `packages/core/src/agent.ts` — `readConfigFromEnv` (lines 81–122); where the
  env var is *wired* to the config field. A schema field alone does NOT read its
  env var — this mapping is hand-written per knob.
- `packages/core/src/agent.test.ts` — `NUMERIC_FIELD_SPECS` table (lines 246–306)
  driving parametrized config-validation tests; a new row here gives free
  coverage that the env var is actually wired.
- `packages/server/src/index.test.ts` — boots the real server, currently only
  asserts `/health` and static serving.

Excerpts (confirm these match the live code before editing):

`packages/server/src/index.ts:84-112`:
```ts
const MessageBodySchema = Type.Object({
	message: Type.String({ minLength: 1 }),
});

async function readMessage(
	req: Request,
): Promise<Result<{ message: string }, InvalidJsonError | ValidationError>> {
	const json = await Result.tryPromise(() => req.json());
	if (Result.isError(json)) return Result.err(new InvalidJsonError({ message: "invalid JSON" }));
	const body = json.value;
	if (!Value.Check(MessageBodySchema, body))
		return Result.err(new ValidationError({ message: "missing required field: message" }));
	return Result.ok({ message: body.message });
}

function rejectMessageError(err: InvalidJsonError | ValidationError): Response {
	return matchError(err, {
		InvalidJson: () => Response.json({ error: "invalid JSON" }, { status: 400 }),
		Validation: () => Response.json({ error: "missing required field: message" }, { status: 400 }),
	});
}
```

`readMessage` is called at `packages/server/src/index.ts:381` inside
`createStreamMessageHandler`, which is a closure inside `startServer` where the
resolved `config: ResolvedPixiesConfig` is in scope.

Config-knob declaration pattern — `packages/core/src/config-schema.ts:67-76`:
```ts
	httpRateLimit: Type.Integer({
		minimum: 0,
		default: 30,
		description: "Max POST requests per IP per rate-limit window (0 disables)",
	}),
```

**The env wiring is hand-written per knob — this is the part the first run
missed.** `packages/core/src/agent.ts:81-122` (`readConfigFromEnv`) explicitly
maps each field name to its `PIXIES_*` env var; a schema field with no line
here is silently inert. Excerpt of the numeric knobs:
```ts
return Value.Parse(
	PixiesConfigSchema,
	Value.Default(PixiesConfigSchema, {
		...
		httpRateLimit: num("PIXIES_HTTP_RATE_LIMIT"),
		httpRateLimitWindowMs: num("PIXIES_HTTP_RATE_LIMIT_WINDOW_MS"),
		...
		conversationTokenBudget: num("PIXIES_CONVERSATION_TOKEN_BUDGET"),
	}),
);
```
So declaring the knob in the schema (Step 1a) is necessary but NOT sufficient —
Step 1b adds the matching `maxPromptChars: num("PIXIES_MAX_PROMPT_CHARS"),` line
here, next to `conversationTokenBudget` (line 119).

The parametrized test table that proves the wiring —
`packages/core/src/agent.test.ts:246-306` (`NUMERIC_FIELD_SPECS`), sample rows:
```ts
const NUMERIC_FIELD_SPECS: readonly NumericFieldSpec[] = [
	{ envKey: "PIXIES_PORT", field: "port", defaultValue: 3000, min: 1 },
	{ envKey: "PIXIES_CACHE_SIZE", field: "cacheSize", defaultValue: 50, min: 0 },
	{ envKey: "PIXIES_HTTP_RATE_LIMIT", field: "httpRateLimit", defaultValue: 30, min: 0 },
	...
];
```
The loop at `agent.test.ts:308-344` generates, per row: `"foo"`→throw (NaN),
`"3.5"`→throw (non-integer), `min-1`→throw, `"0"`→throw (since `min>=1`), and
`""`→`defaultValue` (empty-as-unset). Adding one row therefore yields the test
that would have caught the original plan bug — the `""`→default case proves the
env var is actually wired, not inert.

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Install   | `bun install`                                        | exit 0              |
| Typecheck | `bun run typecheck`                                  | exit 0, no errors   |
| Lint      | `bun run lint`                                       | exit 0              |
| Format    | `bun run format`                                     | files formatted     |
| Format ck | `bun run format:check`                               | exit 0              |
| Core tests| `bun run --filter '@pixies/core' test`               | all pass            |
| Srv tests | `bun run --filter '@pixies/server' test`             | all pass            |

These are the repo's real commands (verified against `package.json` and
`CONTRIBUTING.md`); the project uses `bun`, not npm/pnpm.

## Scope

**In scope** (the only files you should modify):
- `packages/core/src/config-schema.ts` — declare the `maxPromptChars` knob.
- `packages/core/src/agent.ts` — wire `PIXIES_MAX_PROMPT_CHARS` in
  `readConfigFromEnv`. ONE line only (see Step 1b); do not touch anything else
  in this file.
- `packages/core/src/agent.test.ts` — add one row to `NUMERIC_FIELD_SPECS`
  (Step 1c). No other test changes here.
- `packages/server/src/index.ts` — enforce the cap in `readMessage` / its
  caller and surface a clear error response.
- `packages/server/src/index.test.ts` — add a regression test.

**Out of scope** (do NOT touch):
- Anything in `packages/core/src/agent.ts` other than the single
  `readConfigFromEnv` line named in Step 1b. In particular the agent prompt
  path, model resolution, and the rest of the file are off-limits.
- The token-budget module and `conversationTokenBudget`. The cap is an
  HTTP-boundary guard; it is **not** a replacement for the (separate,
  default-off) token budget.
- The web client. No client change is needed — an over-long prompt is a server
  rejection the existing error toast already surfaces.
- Rate-limiting or ownership on the GET/DELETE routes — that is plan 002.

## Git workflow

- Branch: `advisor/001-cap-prompt-length`
- Commit per logical unit (knob; enforcement; test). The repo uses conventional
  commits — e.g. `feat(server): enforce maxPromptChars on incoming prompts`,
  `feat(core): add PIXIES_MAX_PROMPT_CHARS config knob`, `test(server): ...`.
  See `git log --oneline -10` for the exact prefix style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Declare and wire the `maxPromptChars` knob (three sub-edits)

A new config knob needs THREE things in this codebase — declare it, wire its
env var, and register it in the parametrized test table. All three are required;
the first run failed because only the declaration was planned.

**Step 1a — declare the field** in `packages/core/src/config-schema.ts`, in
`PixiesConfigSchema`, mirroring the `httpRateLimit` exemplar:

- Type: `Type.Integer({ minimum: 1, default: 20000, description: "..." })`.
- Default `20000` characters (generous for any real place query; large enough
  not to bite legitimate use, small enough to kill multi-MB amplification).
- `minimum: 1` so a misconfig can't disable the cap — always-on, no `0` sentinel.
- Place it next to `conversationTokenBudget` (line 151) since both are
  server-side cost knobs.
- JSDoc/comment naming the env var (`PIXIES_MAX_PROMPT_CHARS`) and the default,
  matching the comment style of neighbouring fields.

**Step 1b — wire the env var** in `packages/core/src/agent.ts` `readConfigFromEnv`
(the object literal at lines 89–120). Add exactly one line, next to
`conversationTokenBudget: num("PIXIES_CONVERSATION_TOKEN_BUDGET"),` (line 119):

```ts
			maxPromptChars: num("PIXIES_MAX_PROMPT_CHARS"),
```

Without this line the env var is inert (the schema default of 20000 always wins)
— which is the exact bug the first run caught. Do not edit anything else in
`agent.ts`.

**Step 1c — register the test row** in `packages/core/src/agent.test.ts`
`NUMERIC_FIELD_SPECS` (lines 246–306). Add one entry matching the field:

```ts
	{ envKey: "PIXIES_MAX_PROMPT_CHARS", field: "maxPromptChars", defaultValue: 20000, min: 1 },
```

Place it after the `PIXIES_OVERPASS_TIMEOUT_MS` entry (last row, line 300–305)
to match the schema field order loosely. The parametrized loop at lines 308–344
then auto-generates five tests for this knob — including the critical
`PIXIES_MAX_PROMPT_CHARS=""` resolves to default `20000` case (line 340) that
proves the wiring from Step 1b actually takes effect.

**Verify**:
- `bun run typecheck` → exit 0. The new field now appears on
  `ResolvedPixiesConfig` (the `Static<>` of the schema).
- `bun run --filter '@pixies/core' test` → all pass, INCLUDING the five new
  parametrized tests for `PIXIES_MAX_PROMPT_CHARS`. If the `=""` resolves to
  default test FAILS, Step 1b is wrong (the env line is missing or mis-named) —
  fix it before moving on; do not proceed to Step 2 with an inert knob.

### Step 2: Enforce the cap in `readMessage`

The goal: a prompt longer than `config.maxPromptChars` is rejected with HTTP 400
*before* it reaches the agent, with a response body that names the limit.

`readMessage` is currently a module-level function with no access to `config`.
Two acceptable shapes — pick one and apply it consistently:

- **Option A (recommended):** make the schema limit-aware. Add a second
  parameter: `readMessage(req, maxPromptChars)`. Build the check with TypeBox by
  constructing the schema inside the function:
  ```ts
  const body = json.value;
  const schema = Type.Object({ message: Type.String({ minLength: 1, maxLength: maxPromptChars }) });
  if (!Value.Check(schema, body))
  	return Result.err(new ValidationError({ message: `message exceeds ${maxPromptChars} characters` }));
  ```
  Then update the call site at `index.ts:381` to pass `config.maxPromptChars`.
  Update `rejectMessageError`'s `Validation` arm so the wire message is not the
  stale "missing required field" string — e.g.
  `Response.json({ error: err.message }, { status: 400 })` (the `ValidationError`
  now carries the specific reason), or split into two arms if you prefer to keep
  a distinct message for the empty-body case.

- **Option B:** keep `MessageBodySchema` as-is for the empty check, and add an
  explicit `if (body.message.length > maxPromptChars)` after the `Value.Check`,
  returning a `ValidationError` with a length-specific message.

Either way: the enforcement MUST happen before `store.streamPrompt` is called
(it already does — `readMessage` runs first in `createStreamMessageHandler`).

**Verify**:
- `bun run typecheck` → exit 0.
- `bun run lint` → exit 0.

### Step 3: Add a regression test

In `packages/server/src/index.test.ts`, add a test that posts an over-long
message and asserts a 400. Model after the existing boot pattern at
`index.test.ts:53-67` (it already boots a real server on `port: 0` and fetches
against `instance.server.port`).

The test does NOT need an agent stub: the over-long body is rejected inside
`readMessage`, before any agent/LLM call, so reusing the existing `instance`
(and its `apiKey: "test-key"`) is safe. Send a body whose `message` is longer
than the config's `maxPromptChars` (the existing config object at
`index.test.ts:23-51` does not set `maxPromptChars`, so it will use the schema
default `20000` — generate a string of length `20001`).

```ts
test("POST /conversations rejects a prompt over maxPromptChars with 400", async () => {
	const base = `http://localhost:${instance.server.port}`;
	const res = await fetch(`${base}/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "x".repeat(20001) }),
	});
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(body.error).toMatch(/character/i);
});
```

**Verify**: `bun run --filter '@pixies/server' test` → all pass, including the
new test.

## Test plan

- New test (Step 3): over-long prompt → 400 with a length-related error message.
- Also confirm the happy path is unaffected: an existing or new short-message
  assertion is out of scope here (the POST route has no agent stub — see plan
  002's note), so do NOT add a passing-prompt test; the over-long rejection is
  the only assertion this plan adds.
- Pattern source: `packages/server/src/index.test.ts:62-68` (the `/health` fetch
  test) for the boot + fetch shape.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] `bun run --filter '@pixies/core' test` exits 0; the five new parametrized
      tests for `PIXIES_MAX_PROMPT_CHARS` exist and pass (esp. `=""` → 20000)
- [ ] `bun run --filter '@pixies/server' test` exits 0; the over-length 400 test exists and passes
- [ ] `grep -rn "maxPromptChars\|PIXIES_MAX_PROMPT_CHARS" packages/core/src/config-schema.ts packages/core/src/agent.ts packages/server/src/index.ts` returns matches in all three files (declared, wired, enforced)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] (SKIP — reviewer maintains index) `plans/README.md` status row

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift since
  `8268077`).
- `readMessage` turns out to be called from anywhere other than
  `createStreamMessageHandler` (grep `readMessage(` across `packages/server`) —
  if there are other callers, they also need the limit threaded through.
- The Step 1c `=""` → default test does NOT pass after Step 1b (meaning the env
  wiring still isn't taking effect). Do not paper over it — report what
  `readConfigFromEnv` actually does.
- `readConfigFromEnv` in `agent.ts` does NOT use the simple `num("PIXIES_*")`
  per-field mapping shown in the excerpt (e.g. it's been refactored to a loop or
  a generic resolver). If so, the wiring step is different — report rather than
  guess.
- The new server test would require a real LLM call to pass (it must not — the
  rejection happens pre-agent).

## Maintenance notes

For whoever owns this after it lands:

- The cap is an HTTP-boundary guard, NOT the token budget. If
  `conversationTokenBudget` is later enabled by default, keep both — they guard
  different things (per-request size vs per-conversation cumulative tokens).
- If a legitimate use ever needs longer prompts, the operator raises
  `PIXIES_MAX_PROMPT_CHARS`; no code change required.
- A reviewer should confirm the 400 is returned *before* any `store.create()`
  or agent call (ordering inside `createStreamMessageHandler`:
  rate-limit → readMessage → resolveId → streamPrompt). The current ordering
  already has readMessage before resolveId, so an over-long request must NOT
  create a conversation row.
- Related follow-up (separate plan, not this one): the GET/DELETE route
  protection is plan 002.
