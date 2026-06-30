# Pixies agent evals

LLM-as-judge evals for the Pixies place agent. Hits the live SSE endpoint
(`POST /conversations`), parses the tool-execution stream, and grades each
response with a mix of deterministic checks and an LLM rubric.

The suite exists to catch two things at once:

1. **Answer accuracy** — does the agent return real OSM data that actually
   answers the question (right place, right feature kind, no hallucination)?
2. **Persistence** — does the agent reach a *displayed* answer, or does it give
   up after a coding error / 0-result / diagnosis? This is the failure mode the
   `gave_up` status and the "give-up probe" cases target directly.

The agent emits **no prose** — its entire answer lives in
`tool_execution_end.result.details` (`stdout` + `displays`). So the provider
parses the SSE stream into a transcript and the judge grades that, not chat text.

## Layout

```
evals/
  promptfooconfig.yaml     config, shared asserts, test cases + rubrics
  src/pixies_provider.mjs  custom provider: SSE → transcript + metadata
  .env.example             base URL + judge credentials
```

## Setup

```sh
cd evals
cp .env.example .env        # set PIXIES_EVAL_BASE_URL + OPENAI_API_KEY
bun install                 # installs promptfoo locally (isolated from the monorepo)
```

Requires Node 22+ or Bun. The instance under test needs no auth (Pixies v0.1).

## Run

```sh
bun run eval          # full run: every case x3, concurrency 1 (see commandLineOptions)
bun run eval:quick    # 1-shot per case — smoke test in ~3-4 min
bun run view          # open the results viewer (web UI) in a browser
```

`maxConcurrency: 1` is deliberate — Pixies rate-limits the POST endpoints per IP
and the OSM backing services are shared and throttled. Raise it only if you know
the target can take it.

## What each run produces

Per test case the provider returns two things:

- **`output`** — a readable transcript (prompt, each `execute_code` call with its
  code + stdout, the displayed features with `name @ lat, lon`, final status).
  This is what the `llm-rubric` judge reads. Save it to hand to opencode when a
  case fails — that's the debug loop.
- **`metadata`** — structured fields (`status`, `displaysCount`, `retryCount`,
  `errorToolCallCount`, `errorEvent`, `displayedNames`, …). Deterministic
  `javascript` asserts read this via `context.providerResponse.metadata`.

### Status taxonomy (`metadata.status`)

| status             | meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `answered`         | reached a displayed map result — the only passing status        |
| `gave_up`          | wrote code but produced zero displays (the regression signal)   |
| `no_tool_call`     | agent ended without writing any code                            |
| `service_busy`     | OSM backing service overloaded (transient, not the agent's fault) |
| `budget_exceeded`  | hit the conversation turn/token cap                             |
| `error`            | other fatal `error` event                                       |

The shared `answered` javascript assert (in `defaultTest`) gates every case on
`status === "answered"`, so a give-up fails loudly with a reason pointing at the
transcript.

## Judge

Default grader is `openai:gpt-4.1` (needs `OPENAI_API_KEY`). Swap with the
`--grader` flag or by changing `commandLineOptions.grader` in the config, e.g.
`--grader anthropic:claude-3-5-sonnet-latest` (set the matching key in `.env`).

## Adding a case

Add an entry under `tests:` in `promptfooconfig.yaml`. Minimally:

```yaml
- description: <short label>
  vars: { message: "<the place question>" }
  assert:
    - type: llm-rubric
      value: |
        <what a correct answer looks like — be specific about place + feature kind>
```

The shared `answered` gate applies automatically. Add a `javascript` assert
(reading `context.providerResponse.metadata`) when there's a rock-solid
deterministic check (e.g. a brand name must appear in `displayedNames`).
