# Monty vs `quickjs-emscripten` for the Pixies Agent Sandbox

Assessment of [`pydantic/monty`](https://github.com/pydantic/monty) (v0.0.18) as the
sandbox for an LLM-written-code agent in pixies, against the previously-favoured
`quickjs-emscripten` (QuickJS compiled to WASM, running JS).

Sources read: README, AGENTS.md, all 24 files in `limitations/`, the JS package
(`crates/monty-js/`), the `web_scraper` example, the JS test suite, `package.json`,
`pyproject.toml`, and live npm/PyPI metadata.

---

## TL;DR

**Use Monty. It is a near-perfect fit and `quickjs-emscripten` is not close.**

- There is a first-party `@pydantic/monty` npm package with a TypeScript API,
  shipped as a napi binding over a Rust subprocess pool. Bun supports napi.
- Async host functions work transparently — exactly what pixies needs for
  Overpass/Nominatim calls.
- The `examples/web_scraper/` in the Monty repo is *the pixies pattern* — LLM
  writes Python that calls host functions (`open_page`, `beautiful_soup`,
  `record_model_info`); host functions are async and do real I/O. Pixies is
  strictly simpler than that example.
- It is built by the Pydantic team (7.8k stars, 17 npm releases in 4 months,
  pushed yesterday), designed explicitly for "LLM writes code that calls your
  functions," and is slated to power Pydantic AI's code-mode.
- The only real risk is immaturity (still `0.0.x`, no classes in sandbox yet).
  Mitigations exist and the trade-off is favourable — see §8.

---

## 1. What Monty is

A minimal, sandboxed Python interpreter written in Rust by Samuel Colvin
(Pydantic's author). It uses Ruff's `ruff_python_parser` for parsing but
implements its own bytecode VM and runtime, so it has no dependency on CPython.

Two execution modes:

1. **Subprocess pool** (the default for `@pydantic/monty` on Node/Bun): a pool
   of `monty --subprocess` worker processes, spoken to over a length-prefixed
   protobuf protocol. A worker that crashes (stack-overflow abort, allocator
   abort) is discarded and replaced — the host is never at risk.
2. **In-process WASM** (`@pydantic/monty/wasm` subpath): the same napi binding
   compiled to `wasm32-wasip1-threads`. Used in browsers / when subprocesses
   are impossible. **No crash isolation** — a sandbox crash takes the host down.

The README quotes 0.06 ms startup latency and runtime within 5× of CPython in
either direction. Resource limits (memory, allocation count, cumulative
execution time, recursion depth) are enforced *inside* the worker.

---

## 2. Python feature support matrix

Source: `limitations/language.md`, `limitations/modules.md`,
`limitations/classes.md`, `limitations/asyncio.md`, `limitations/typing.md`.

### What works

| Area | Status |
| --- | --- |
| `def`, `async def`, nested functions, closures, decorators | ✅ |
| Control flow: `if`/`elif`/`else`, `for`, `while`, `break`, `continue`, `pass`, `assert`, `global`, `nonlocal`, `return` | ✅ |
| `try`/`except`/`else`/`finally`, `raise … from …` | ✅ |
| List / dict / set comprehensions | ✅ (generator expressions degrade to lists, temporary) |
| `import x`, `import x.y`, `from x import y, z as w` (stdlib allowlist only) | ✅ |
| f-strings incl. `=`, `!r`/`!s`/`!a`, format specs | ✅ |
| `async def` + `await` (single-shot coroutines, host-driven) | ✅ |
| `asyncio.run(coro)`, `asyncio.gather(*aws)` | ✅ — `gather` runs concurrently when every branch is blocked on a host call |
| Full modern Python type hints in annotations + bundled `ty` for static type checking | ✅ |
| Bigint, bytes, str, list, tuple, dict, set, frozenset, datetime, timedelta, timezone, dataclass-shaped values | ✅ |

### Stdlib modules available

`asyncio`, `datetime`, `json`, `math`, `os` (host-intercepted), `pathlib`,
`re`, `sys`, `typing` (inert markers, see below). That's it.

### What is deliberately excluded

| Excluded | Reason / impact |
| --- | --- |
| **`class` definitions** (planned, not yet) | Use functions or host-supplied dataclasses. LLM code rarely needs classes for pixies-style glue. |
| `match` statements (planned) | Use `if`/`elif`. |
| `yield` / generator functions | Generator *expressions* work (materialise to list). |
| `async with`, `async for`, async comprehensions | No async iteration protocol. `asyncio.gather` covers the concurrency case. |
| `del`, exception groups (`except*`), PEP 695 `type` aliases, walrus `:=`, `*args` in calls, t-strings | Minor — all have trivial workarounds. |
| Wildcard imports (`from m import *`) | Raises `ImportError`. |
| Third-party libraries (shapely, geopandas, numpy, etc.) | **Explicit non-goal.** No `site-packages`, no `sys.path`. All non-trivial work must call host functions. |
| Most of the stdlib (`collections`, `itertools`, `functools`, `io`, `csv`, `http`, `urllib`, `socket`, `subprocess`, `ctypes`, …) | Either unimplemented or deliberately excluded for sandboxing. |
| `typing` at runtime | Inert markers — no `get_type_hints`, `cast`, `TypedDict`, etc. Type validation must happen on the host. |
| User-defined dunders (`__init__`, `__iter__`, `__getitem__`, …) | Only consulted on host-supplied dataclasses. |

**Implication for pixies:** the model writes glue — call `geocode`, call
`find_features`, filter, call `display`. No classes, no shapely. The host
(pixies-server, TypeScript) owns the real spatial logic; the sandbox just
orchestrates calls and does cheap data shaping with dicts/lists/comprehensions.
This is exactly the supported pattern.

---

## 3. Security model

Strong and explicit. Quoting `AGENTS.md`:

> It's ABSOLUTELY CRITICAL that there's no way for code run in a Monty sandbox
> to access the host filesystem, or environment or to in any way "escape the
> sandbox".

### What sandboxed code can access

- **Filesystem:** nothing by default. Host directories can be mounted at virtual
  POSIX paths (`MountDir`) with `read-only` / `read-write` / `overlay` modes.
  Path canonicalisation, boundary checks, symlink rejection, and `..` escape
  prevention go through one security-critical function
  (`fs::path_security::resolve_path`).
- **Network:** nothing. No `socket`, no `http`, no `urllib`. Network happens via
  host-supplied external functions.
- **Process / subprocess / shell:** nothing. The interpreter exposes no
  `fork`/`exec`/subprocess surface — this is a hard sandbox invariant the pool
  relies on (killing the worker PID must unblock the parent's pipe read).
- **Environment variables:** workers are spawned with an **empty environment**
  (Windows keeps `SystemRoot` only). `os.getenv` etc. are OS callbacks answered
  by the host, never reads of the worker's own env.
- **Imports:** allowlist only. `__import__` is not defined. Relative imports
  raise. Anything outside the allowlist raises `ModuleNotFoundError`.

### Host-function injection (this is the key API)

You pass `externalFunctions: { name: fn, ... }` to `session.feedRun(code, opts)`.
The sandbox resolves the name, calls your JS function with the args (positional +
a trailing kwargs object), and awaits the result if it's a promise. JS errors
cross into the sandbox as Python exceptions, typed by `error.name` when it
matches a known Python exception (`TypeError`, `ValueError`, …), otherwise
`RuntimeError`.

This is *exactly* the surface pixies needs:

```ts
await session.feedRun(code, {
  externalFunctions: {
    geocode: async (q: string) => nominatim.search(q),
    find_features: async (area: unknown, query: unknown) => overpass.query(...),
    filter: (features: unknown[], pred: unknown) => features.filter(...),
    spatial_join: async (a: unknown, b: unknown) => ...,
    display: (features: unknown) => { /* push to SSE stream */ },
  },
})
```

### Resource limits

Enforced inside the worker, terminal for the session if exceeded:

```ts
const session = await pool.checkout({
  limits: { maxMemory: 100 * 1024 * 1024, maxDurationSecs: 5, maxRecursionDepth: 100 },
})
```

- Memory / allocation tracking is global; sizes approximate (elides HashMap
  padding etc.) but pre-checked for amplification attacks (`'x' * n`, `str.ljust`,
  f-string dynamic width/precision, integer power, …).
- `maxDurationSecs` is **cumulative execution time**, not wall clock — the
  sandbox clock pauses while suspended on a host call and between feeds. It
  accumulates across feeds and travels inside dumps/snapshots.
- Recursion hard-capped at 1000 frames; `RecursionError` on the 1001st.
- Pool-level `requestTimeout` is the backstop: if the worker wedges, the host
  kills the PID and raises `MontyCrashedError` with `timedOut: true`.
- After a `ResourceError`, heap state is unspecified — discard the session.
- Wire framing: 256 MiB per frame, 1 GiB resident decoded bytes per frame
  (covers the ~22× blow-up from cheap elements like `None`).
- Recursion: 200 AST levels (30 in debug), 200 `json.loads` depth.

---

## 4. Async support

Critical for pixies — every host function makes HTTP requests.

- `async def`/`await` works inside the sandbox. `asyncio.run(coro)` and
  `asyncio.gather(*aws)` are the only two `asyncio` functions.
- **Host functions can be async.** From `crates/monty-js/__test__/async.spec.ts`:

  ```ts
  await run('await fetch_data()', {
    externalFunctions: { fetch_data: async () => '...' },
  })
  ```

  A promise returned by the JS function is registered as a sandbox future and
  delivered automatically when it resolves.
- Concurrency model: cooperative, host-driven. `gather` suspends Monty whenever
  every branch is blocked on a host call, hands all pending calls to the host,
  resumes when results come back. No in-sandbox event loop, no preemption, no
  threads.
- No `async for`/`async with`/async comprehensions — `gather` is the only
  composition tool. Pixies doesn't need anything else.
- Coroutines are single-shot; awaiting twice raises `RuntimeError`. Not a problem
  in practice — store results, not coroutines.

This is a perfect match for pixies: `await asyncio.gather(geocode(a), geocode(b),
geocode(c))` is the idiomatic way to parallelise Nominatim calls.

---

## 5. Bun integration path

**Use `@pydantic/monty` (the napi binding) — not the WASM subpath.**

### Why napi, not WASM

- The napi build ships the interpreter as a subprocess pool with **crash
  isolation** — a worker abort on adversarial code raises `MontyCrashedError`,
  the pool replaces it, the Bun process keeps serving the next request.
- The `/wasm` subpath runs the interpreter in-process: a sandbox crash is a host
  crash. Reserve it for browser-only deployments (pixies-server doesn't need it).
- Bun supports napi modules (`.node` files) out of the box; napi-rs produces ESM
  bindings that Bun loads directly. No FFI glue.

### Installation

```bash
bun add @pydantic/monty
```

The main package has `optionalDependencies` on platform-specific sub-packages
(`@pydantic/monty-linux-x64-gnu`, `…-darwin-arm64`, `…-win32-x64-msvc`, …) that
ship the `.node` binding and the `monty` worker binary — the same install model
as esbuild/swc. Five npm targets are published; Linux x64/arm64 and macOS
x64/arm64 cover typical pixies deployments, Windows x64 is available too.

The package sets `"engines": { "node": ">= 20" }`; Bun satisfies this. The
TypeScript types ship in-box (`dist/index.d.ts`).

### Worker binary resolution

Order: explicit `binaryPath` → `MONTY_BIN` env var → the installed platform
package → `PATH` → cargo workspace `target/` (dev fallback). For pixies
production, the platform-package path is the default and requires no
configuration.

### Skeleton for pixies-server

```ts
import { Monty } from '@pydantic/monty'

const pool = await Monty.create({
  minProcesses: 1,
  maxProcesses: 8,            // cap; checkouts beyond it wait
  requestTimeout: 30,        // hard per-turn deadline (seconds)
  durationLimitGrace: 1,     // maxDurationSecs backstop
})

async function runAgentTurn(code: string) {
  await using session = await pool.checkout({
    typeCheck: true,
    typeCheckStubs: GEOCODE_STUBS,        // .pyi describing our external functions
    limits: { maxMemory: 64 * 1024 * 1024, maxDurationSecs: 5 },
  })
  return await session.feedRun(code, {
    inputs: { /* session-scoped globals */ },
    externalFunctions: {
      geocode: async (q: string) => nominatim.search(q),
      find_features: async (area, query) => overpass.query(area, query),
      filter: (features, pred) => features.filter(pred),
      spatial_join: async (a, b) => join(a, b),
      display: (features) => { sseBus.emit(features); return None },
    },
    printCallback: (stream, text) => log.debug({ stream, text }),
  })
}
```

### Snapshotting (free feature worth flagging)

`session.dump()` serialises an idle worker; `snapshot.dump()` serialises a
paused-mid-feed worker; both restore into a fresh session. Execution-time
budgets and limits travel in the dump. Useful for: resuming a long agent
turn across SSE reconnects, forking an agent mid-thought, caching warm
sessions per user. Not required for v1.

### Performance overhead

- Worker checkout + a trivial `1 + 2` snippet: ~0.06 ms startup, per the README
  benchmark table (Monty's headline number vs Docker 195 ms, Pyodide 2800 ms,
  WASI 66 ms).
- Real cost for pixies is dominated by Overpass/Nominatim round-trips (tens to
  hundreds of ms each), not sandbox overhead. A pool of 8 workers handles
  many concurrent users on one machine.
- No measurable language tax: Python-in-Monty runs within 5× of CPython either
  way, and the sandbox code itself does almost no compute (the host does).

---

## 6. Maturity and ecosystem

| Signal | Value |
| --- | --- |
| GitHub stars | 7,795 |
| Forks | 380 |
| Open issues | 72 |
| Repo created | 2023-05-28 (Monty itself, recent rewrite) |
| npm `@pydantic/monty` first release | 2026-02-02 |
| npm latest | 0.0.18 (2026-05-29) |
| npm releases in 4 months | 17 |
| PyPI `pydantic-monty` releases | 19, latest 0.0.18 |
| Last push to main | 2026-06-27 (yesterday, as of this report) |
| Owner | Pydantic team (Samuel Colvin — author of Pydantic, Pydantic AI) |
| License | MIT |
| Backed by | Pydantic Inc. — Monty will power `code-mode` in Pydantic AI |
| Community bindings | Go ([gomonty](https://github.com/ewhauser/gomonty/)), Dart/Flutter (dart_monty) |

**Read:** experimental (the README says so, and the `0.0.x` version agrees), but
under active, well-resourced development by a team that ships. The pace — 17 npm
releases in four months and a push yesterday — is the strongest available signal
that this is not abandonware. Samuel Colvin has a strong track record
(Pydantic, uvicorn, watchfiles).

The `limitations/` directory is exemplary: 24 markdown files, one per feature,
each listing every divergence from CPython. You can predict in advance exactly
what will and won't work.

**Risk:** pre-1.0, so the API will change. The `feed_start` snapshotting API was
re-added in the most recent commit (#507); the pool API was stabilised
recently. Pin the version (`"@pydantic/monty": "0.0.18"`) and budget for one
migration when 0.1 lands.

---

## 7. Python vs JavaScript for the pixies use case

| Consideration | Python (Monty) | JavaScript (quickjs-emscripten) |
| --- | --- | --- |
| Model fluency for function-call glue | **Strong.** LLMs are trained heavily on Python; agentic-code patterns (smolagents, Claude's programmatic tool calling, Anthropic's code execution MCP, Pydantic AI code-mode) all standardise on Python. | Strong, but slightly less canonical for the "LLM writes code that calls tools" pattern. |
| Language mismatch with pixies TS codebase | Mismatch exists, but is **intentional and helpful**: the sandbox is a security boundary, and a different language makes it harder to leak host abstractions. The host API is typed TS; the sandbox sees only what you expose. | No mismatch — same language host and guest. Slightly easier to blur the boundary, which is a security downside, not an upside. |
| Async semantics for I/O | `async`/`await` + `asyncio.gather` is the idiomatic, well-trodden pattern. LLMs write it correctly. | Promises + `Promise.all` — equally fine, but `async`/`await` in QuickJS-WASM is more fragile to get right under a custom event loop. |
| Available stdlib in sandbox | Tiny allowlist (9 modules). Forces all real work through host functions — which is what you want. | None of JS's "stdlib" is a stdlib in the dangerous sense; QuickJS ships a minimal global. Comparable. |
| Spatial libraries (shapely, geopandas) | **Not available in Monty and never will be** (explicit non-goal). But pixies doesn't need them in-sandbox — the host (pixies-server) does spatial ops and exposes them as functions. The "Python has better GIS libs" argument is a red herring for this architecture. | N/A — equivalent. |
| Static type checking of LLM output | **Built-in.** `checkout({ typeCheck: true, typeCheckStubs })` runs `ty` (Astral's type checker, bundled) on the LLM's code before execution. Type errors return as `MontyTypingError` and the session survives — perfect feedback loop for re-prompting. | None. |
| Sandboxing without containers | Native (designed for this). | Native (WASM). |
| Crash isolation of host process | **Yes** via subprocess pool. | No — in-process WASM. A malicious input that triggers a QuickJS bug takes down Bun. |
| Resource limits (CPU/mem/time) | Built-in, enforced inside worker. | Must be implemented manually on top of QuickJS interrupts. |

The "Python has shapely" point in the prompt is the main reason one might lean
Python over JS in general — but Monty's whole design is that *the sandbox does
not run heavy libraries.* Spatial heavy lifting belongs in pixies-server (TS),
exposed as host functions. The sandbox just sequences calls and shapes data.

---

## 8. Comparison with `quickjs-emscripten`

| Dimension | Monty (`@pydantic/monty`) | `quickjs-emscripten` |
| --- | --- | --- |
| Distribution | First-party npm, native napi binding + WASM subpath. | Third-party npm, WASM only. |
| Execution model | Subprocess pool (default) → host crash-isolated. In-process WASM (subpath) → not isolated. | In-process WASM only → host not isolated. |
| Language | Python subset (no classes yet, no third-party libs ever). | JavaScript (ES2020-ish, full). |
| Async host calls | First-class — async functions become sandbox awaitables. `asyncio.gather` for parallelism. | Possible but hand-rolled: you drive the QuickJS interrupt loop, manage pending promises, marshal results yourself. |
| Type checking of LLM code | Bundled `ty`, opt-in per checkout, errors don't kill the session. | None. |
| Resource limits | Built-in (memory, allocations, cumulative exec time, recursion). | DIY via `JS_SetInterruptHandler` + external memory accounting. |
| Snapshotting | First-class (`dump()`/`load()`), crosses process boundaries, includes time budgets. | `quickjs-emscripten` has snapshotting of the JS engine but no host-aware story. |
| Maintainer activity | Pydantic team; pushed yesterday; 17 releases in 4 months; slated to back Pydantic AI code-mode. | Library is mature but low-motion; agentic use is not its focus. |
| Footprint | ~4.5 MB platform package (binding + worker binary). | ~1 MB WASM. |
| Tail risk | Language gaps may surprise the model (no `class`, no `match`). Documented in `limitations/`. | Fewer language gaps, but you build and maintain all the safety machinery. |
| Fit for "LLM writes glue that calls my functions" | The explicit, sole use case. Ships an example (`web_scraper/`) that is the pixies pattern. | General-purpose JS runtime; agentic glue is your problem to build. |

The only categories where QuickJS-WASM wins are: smaller bundle, full language
support (classes etc.), and library maturity. None of these matter much for
pixies: 4.5 MB is irrelevant on a server; LLM glue rarely needs classes; and
"you build and maintain all the safety machinery" is precisely the cost Monty
exists to eliminate.

---

## 9. Risks and mitigations (Monty)

1. **Pre-1.0 API churn.** Pin to `0.0.18`. Wrap the pool/session calls behind
   one internal module in pixies-server so a migration touches one file.
2. **No `class` in sandbox.** Instruct the model in the system prompt:
   "use functions and plain dicts; do not define classes." The `web_scraper`
   example uses exactly this instruction and shows sonnet-4.5 complying.
3. **Worker binary is a native executable.** Docker images must match the
   platform package (linux-x64-gnu or linux-arm64-gnu). Verify the production
   image architecture at build time.
4. **Single-shot coroutines.** Document in the system prompt: "store results,
   not coroutines; await once."
5. **Nesting/size limits on values crossing the boundary** (~48 nested lists,
   256 MiB wire / 1 GiB resident per frame). Return summaries from host
   functions, not raw Overpass responses — which pixies should do anyway for
   context-window reasons.

---

## 10. Recommendation

**Adopt Monty (`@pydantic/monty`, napi binding) as the pixies agent sandbox.
Do not use `quickjs-emscripten`.**

Concrete next steps:

1. `bun add @pydantic/monty` in `@pixies/server`; pin `0.0.18`.
2. Add an internal `sandbox/` module that owns `Monty.create()`, checkout
   options, and the host-function bridge to the existing OSM clients.
3. Generate `.pyi` stubs from the existing tool schemas (TypeBox → Python type
   stubs) and pass them as `typeCheckStubs` so LLM code is type-checked before
   execution.
4. Author the system prompt after `examples/web_scraper/main.py` — list
   available stdlib, forbid classes, show `asyncio.gather` idiom.
5. Record an ADR (this is architecturally significant and hard to reverse:
   the sandbox language shapes the prompt schema, the host API, and the
   snapshot format).
6. Re-evaluate at Monty 0.1 (classes, `match`, etc. should land by then).

The match with pixies is unusually good: Monty is purpose-built for exactly
this architecture, the reference example already demonstrates it on a harder
problem (Playwright + BeautifulSoup), and the alternative (`quickjs-emscripten`)
asks pixies to rebuild — by hand — most of what Monty already provides.
