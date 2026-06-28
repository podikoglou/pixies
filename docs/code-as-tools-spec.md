# Spec: Code-as-Tools with Monty Sandbox

**Status:** Implemented — experimental, shipping behind `execute_code`
**Supersedes:** PR #245, ADR-0013
**Research basis:** CodeAct (ICML 2024), Spatial-RAG (arXiv 2502.18470), CRAG (arXiv 2401.15884), GROKE (arXiv 2601.07375)

---

## 1. TL;DR

Replace the seven-tool + dependency-layer architecture with a **single `execute_code` tool backed by a sandboxed Python session (Monty)**. The model writes synchronous Python that calls our spatial host functions. Results auto-display on the map. Variables persist across calls via code replay + result caching. The model responds with tool calls only — no natural-language answers.

---

## 2. Problem

The current architecture (PR #245, issue #244) failed in production:

1. **The model cannot use the ref mechanism.** It hallucinated tool-call IDs, never emitted multi-tool batches, and abandoned tools after `UnknownRefError` failures.
2. **The `ResultStore` was never written to.** No tool's `execute` path calls `ctx.store.set(...)`, so cross-turn refs never resolve.
3. **`geocode`'s `executionMode: "sequential"` poisons any batch** containing it — the framework forces the entire batch sequential.
4. **Content dumps waste context.** `find_features` dumps 50 elements per call. The model called it 3x in the failure trace.
5. **The entire dependency layer is dead code in production.** Tests pass; users get nothing.

---

## 3. Architecture

### 3.1 The execution loop

```
User query
    │
    ▼
┌──────────────────────────────────┐
│  LLM call #1                     │  Model writes Python code for
│  System prompt + query + history │  the full chain: geocode →
│  → execute_code(code)            │  find_features → filter →
│                                  │  spatial_join, in one block
└──────────────┬───────────────────┘
               │ code string
               ▼
┌──────────────────────────────────┐
│  Monty sandbox (fresh instance)   │  No LLM in the loop
│                                  │
│  Execute code                    │  Previous code replayed silently
│  (with replay prefix if not      │  (cached results) to restore
│   first call in conversation)    │  variable state.
│                                  │
│  ├─ geocode() → Nominatim        │  All I/O via host functions.
│  ├─ find_features() → Overpass   │  Auto-display pushes map data
│  ├─ filter() → in-memory         │  to the client when the tool
│  ├─ spatial_join() → haversine   │  result arrives.
│  └─ display() → map data         │
│                                  │
│  → stdout + error/traceback      │
└──────────────┬───────────────────┘
               │ stdout / error
               ▼
┌──────────────────────────────────┐
│  Model sees: stdout or error     │  If error: fix and retry.
│  Tool result renders as          │  If success: map widget shown.
│  MapWidget if display data       │
│  exists, else ToolCallCard.      │
└──────────────────────────────────┘
```

**Simple query:** 1 LLM call (one `execute_code`). Map renders from auto-display data.
**Complex query with iteration:** 2–3 LLM calls (retry after error or broaden after 0 results).

### 3.2 Why this works

| Design decision | Evidence |
|---|---|
| Code actions, not structured tool calls | CodeAct (ICML 2024): +20.7 pts over JSON on complex multi-tool tasks. Variables are the data-flow mechanism — free, no refs. |
| Single execute_code call per query | The model writes the full chain in one Python block. No round-trips between steps means faster execution and no ref-coordination overhead. |
| Synchronous functions (no await) | Monty's external functions are injected as sync globals. The executor handles async I/O internally via the snapshot loop. Model code is simpler — no `await`, no `asyncio`. |
| Auto-display on data functions | `find_features` and `spatial_join` push auto-display data. The model rarely calls `display()` directly. Fewer steps, fewer errors. |
| Variable persistence via code replay | Monty has no REPL/session API. Previous code snippets are replayed silently at the top of each new execution with results cached, so variables exist in scope without network cost. |
| Smart functions handle relaxation internally | CRAG (arXiv 2401.15884): retrieval failure detection + correction is a system layer. |
| Budgeted summaries, not full dumps | Functions auto-print one-line summaries to stdout. Full data stays in Python variables — the model inspects with `print()` only when needed. |
| Python, not JavaScript | Python is the canonical language for "LLM writes code that calls tools." 3x more token-efficient than JSON for the same semantics. |

---

## 4. Host Function API

The model sees one tool: `execute_code(code: str)`. Inside the Monty sandbox, these host functions are available as globals. All are **synchronous** from Python's perspective — no `await`, no `asyncio.gather`.

### 4.1 `geocode`

```python
geocode(query: str) -> dict | None
```

Geocodes a place name via Nominatim. Returns the top match, or `None` if no results.

**Return shape:**
```python
{
    "id": "way/5013364",
    "name": "Tour Eiffel",
    "lat": 48.8582599,
    "lon": 2.2945006,
    "type": "tower",
    "display_name": "Tour Eiffel, 5, Avenue Anatole France, ...",
    "bbox": [48.857, 2.293, 48.859, 2.296],   # present for area-returning places
    "alternatives": [                            # present when >=2 strong matches
        {"name": "Springfield", "lat": 37.2, "lon": -93.3, "display_name": "Springfield, Missouri, USA"}
    ]
}
```

**Auto-printed summary:** `geocode("Eiffel Tower, Paris") -> Tour Eiffel (48.858, 2.295)`

### 4.2 `find_features`

```python
find_features(
    *,
    types: list[str] | None = None,       # ["pharmacy", "restaurant", "LIDL"]
    tags: list[dict] | None = None,        # [{"key": "amenity", "value": "pharmacy"}]
    area: dict,                            # see Area formats below
    name: str | None = None,               # case-insensitive regex on name tag
    limit: int = 200,                      # max features to return
) -> dict
```

Primary OSM feature search via Overpass. `types` resolve to OSM tag clauses via the type/brand dictionary. Unknown types fall back to case-insensitive name match.

**Area formats (exactly one required):**

| Key | Value | Resolves to |
|---|---|---|
| `"place"` | `str` — `"Paris, France"` | Geocoded bbox |
| `"around"` | `{"lat": float, "lon": float, "radius": int}` | Overpass `(around:radius,lat,lon)` |
| `"bounds"` | `{"minlat", "minlon", "maxlat", "maxlon"}` | Overpass bbox |
| `"features"` | `list[dict]` — prior result's feature list | Bounding box of the features, expanded by 250m |

**Return shape:**
```python
{
    "features": [
        {
            "id": "node/259546329",
            "name": "Pharmacie Lecourbe Cambronne",
            "lat": 48.8427695,
            "lon": 2.3027722,
            "tags": {"amenity": "pharmacy", "opening_hours": "Mo-Fr 08:30-20:00"},
        },
    ],
    "count": 118,            # total features found by Overpass
    "truncated": True,       # True if features was capped at limit
    "relaxed": False,        # True if auto-relaxation was applied
    "note": None,            # human-readable note when relaxed or on error
}
```

**Auto-display:** Results are automatically pushed to the map when features are found. The model does not need to call `display()` after `find_features`.
**Auto-printed summary:** `find_features(types=["pharmacy"], around=Tour Eiffel, radius=2000m) -> 118 feature(s)\n  top: Pharm 1, Pharm 2, Pharm 3`

### 4.3 `filter`

```python
filter(
    features: list[dict],
    *,
    where: str | None = None,            # "opening_hours =~ /24/7/ AND name !~ /test/"
    sort_by: str | None = None,          # "-population" (descending) or "name"
    limit: int | None = None,
    distinct: bool = False,
) -> list[dict]
```

Synchronous in-memory predicate. The `where` clause supports AND/OR, parentheses, and: `=`, `!=`, `<`, `>`, `<=`, `>=`, `=~` (regex), `!~`, `IS NULL`, `IS NOT NULL`. Numeric comparisons parse OSM's loose formats (`"30 000"`, `"30,000"`, `"~30000"`).

Returns the filtered list (same feature dict shape). No wrapping — it's a plain list.

### 4.4 `spatial_join`

```python
spatial_join(
    *,
    points: list[dict],
    targets: list[dict],
    operation: str,                      # "near" | "nearest"
    radius: int,                         # metres
) -> list[dict]
```

Synchronous haversine join. Returns pairs sorted by distance:

```python
[
    {
        "point": {"id": "way/5013364", "name": "Tour Eiffel", "lat": 48.858, "lon": 2.294},
        "target": {"id": "node/829526567", "name": "Pharmacie", "lat": 48.870, "lon": 2.305},
        "distance": 1623,
    },
]
```

- `"near"`: all targets within radius of each point (many-to-many). Capped at 1000 pairs.
- `"nearest"`: single closest target per point within radius (one-to-one).

**Auto-display:** Results are automatically pushed to the map when pairs are found.
**Auto-printed summary:** `spatial_join(near, 2000m) -> 5 pair(s) (best: 847m)`

### 4.5 `display`

```python
display(
    *,
    markers: list[dict] | None = None,       # [{"lat": float, "lon": float, "label": str}]
    features: list[dict] | None = None,      # feature list -> markers
    pairs: list[dict] | None = None,         # spatial_join output -> markers + polylines
    bounds: dict | None = None,              # {"minlat", "minlon", "maxlat", "maxlon"}
) -> None
```

Pushes map data that renders when the `execute_code` tool result arrives at the client. Multiple calls append to the same display payload. Since `find_features` and `spatial_join` auto-display, the model rarely needs this directly — use it only for custom markers or filtered subsets.

### 4.6 `overpass_query` (escape hatch)

```python
overpass_query(query: str) -> dict
```

Raw Overpass QL. Returns `{"elements": [...], "count": int}`. Use only for queries `find_features` cannot express (recursive relations, historical, complex cross-tag boolean logic).

### 4.7 `reverse_geocode`, `haversine`, `bounds_of`

```python
reverse_geocode(lat: float, lon: float) -> list[dict]   # up to 5 nearby places
haversine(a: dict, b: dict) -> int                       # metres between two {lat, lon} dicts
bounds_of(features: list[dict]) -> dict                  # {"minlat", "minlon", "maxlat", "maxlon"}
```

### 4.8 Sandbox constraints

- **No `await`, no `asyncio`.** All functions are synchronous from Python's perspective.
- **No `import` statements.** No standard library, no third-party packages. Only the injected globals are available.
- **No classes.** Use plain functions, dicts, and lists.
- **Variables persist across calls** via code replay + result caching (see §5).

---

## 5. Session Model

### 5.1 Lifecycle

Each conversation gets one `MontyExecutor`, created lazily when the conversation is created. The executor lives for the conversation's in-memory lifetime (managed by the 24h LRU cache). When the conversation is evicted, the executor is GC'd.

**State:**
- `codeHistory: string[]` — previous code snippets, replayed to restore variable state
- `callCache: Map<string, unknown>` — cached results of external function calls, keyed by (function name, args, kwargs)

### 5.2 Variable persistence (code replay + call caching)

Monty v0.0.18 has **no REPL/session API** for incremental execution. Instead, state is persisted by:

1. **Code prepend:** On the second+ `execute_code` call in a conversation, all previous code snippets are replayed at the top of each new execution. Variables from call 1 exist in scope during call 3.

2. **Call caching:** External function results are cached by `JSON.stringify([functionName, args, kwargs])`. During replay, cached results are returned instantly — no network calls.

3. **`__pixies_replay_end__()` marker:** A synthetic host function injected between replayed and new code. It toggles the executor from replay mode (stdout suppressed, cache lookups active) to live mode (stdout captured, functions execute for real).

This achieves the same semantic as a persistent Python session without Monty's `feedRun()` API.

### 5.3 Concurrency

The server enforces one prompt per conversation (concurrent POSTs get 409). Session access is single-threaded per conversation. Multiple concurrent conversations each have their own `MontyExecutor`.

### 5.4 Persistence across restarts

The Python state is NOT persisted across server restarts. On restart, a conversation gets a fresh executor with empty `codeHistory` and `callCache`. The model sees this as a session reset and must re-fetch any needed data.

---

## 6. Progressive Relaxation

Implemented inside `find_featuresHost`, invisible to the model's code.

**Relaxation schedule when Overpass returns 0 results:**

| Step | Action |
|---|---|
| 0 | Original query as-is |
| 1 | Expand `around` radius x1.5 |
| 2 | Expand `around` radius x2 |
| 3 | Expand `around` radius x3 (around-mode only; skipped for bounds/based queries) |
| 4 | Broaden tag filters: `eq` → `iregex` (case-insensitive) |
| 5 | Drop the most restrictive OR-groups (keep the broadest half) |

At each step, if results are found, return immediately with `relaxed: True` and a note describing the change. If all steps exhaust, return `{"features": [], "count": 0, "relaxed": True}`.

---

## 7. Context Budget

### 7.1 Summary-first returns

Host functions auto-print a one-line summary to stdout on each call. The model sees the summary, not full data:

```
geocode("Eiffel Tower, Paris") -> Tour Eiffel (48.858, 2.295)
find_features(types=["pharmacy"], around=Tour Eiffel, radius=2000m) -> 118 feature(s)
  top: Pharm 1, Pharm 2, Pharm 3
filter(118 features, where="opening_hours =~ /24/7/") -> 3 feature(s)
spatial_join(nearest, 2000m) -> 1 pair(s) (best: 847m)
```

The full data is in Python variables — the model inspects with `print(feature)` when needed.

### 7.2 Feature truncation

`find_features` returns at most `limit` features (default 200). The full `count` is always included. The summary shows the first 3 feature names.

### 7.3 Stdout stripping

Only stdout from the **new code** (after `__pixies_replay_end__()`) is shown to the model. Replay stdout from previous calls is suppressed.

### 7.4 Model response is code-only

The model responds with only `execute_code` tool calls — no text output. The system prompt says "You respond with only tool calls — never a text message." The tool result content is the minimal string `"OK"`; the real data is in the `details` payload consumed by the client.

---

## 8. System Prompt

### 8.1 Structure

```
1. Role — "You are Pixies, an AI agent that answers questions about places using OSM data."
2. Tool-only constraint — never text, always execute_code
3. Auto-display rule — find_features and spatial_join auto-display
4. Execution environment — sandbox framing (no imports, no await, no classes)
5. Variable persistence note
6. Available functions — signatures + one-line descriptions (~200 tokens)
7. Area formats for find_features
8. Coding rules — chaining rule, minimal code, retry on errors
9. OSM guidance — name variants, brand handling, numeric comparisons
10. Examples — 2 patterns (~200 tokens)
```

**Estimated total:** ~1,100 tokens (system prompt) + ~300 tokens (one tool schema: `execute_code`) = ~1,400 tokens. Current architecture: ~4,100 tokens (7 tool schemas + longer prompt).

### 8.2 Coding rules

```
- Start every query with geocode, then chain to find_features / filter /
  spatial_join in the same execute_code block. Never stop after geocode or
  filter alone — those are intermediate steps, not answers.
- Write minimal code. Don't add error handling unless needed.
- Inspect results with print() or len() before using them.
- If your code produces a coding error (NameError, TypeError, RuntimeError,
  SyntaxError from your own code, KeyError), fix the problem and retry in a
  new execute_code call. Never give up on a coding error.
- If a query returns 0 results, the function auto-broadens the search. If
  still nothing, write a broader query in a new execute_code call.
- If a function reports its backing service is temporarily unavailable, do
  not retry.
```

### 8.3 Examples (actual prompt)

```
Nearest 24/7 pharmacy to the Eiffel Tower:

    tower = geocode("Eiffel Tower, Paris")
    pharmacies = find_features(types=["pharmacy"], area={"around": {"lat": tower["lat"], "lon": tower["lon"], "radius": 2000}})
    open_24_7 = filter(pharmacies["features"], where="opening_hours =~ /24\\/7|00:00-24:00/")
    nearest = spatial_join(points=[tower], targets=open_24_7, operation="nearest", radius=2000)

IKEAs near LIDLs in Swedish towns under 30k near Stockholm:

    stockholm = geocode("Stockholm, Sweden")
    towns = find_features(types=["town"], area={"around": {"lat": stockholm["lat"], "lon": stockholm["lon"], "radius": 50000}})
    small_towns = filter(towns["features"], where="population < 30000")
    lidls = find_features(types=["LIDL"], area={"features": small_towns})
    ikeas = find_features(types=["IKEA"], area={"features": small_towns})
    pairs = spatial_join(points=ikeas["features"], targets=lidls["features"], operation="near", radius=2000)
```

Note: no `await`, no `asyncio.gather` — all calls are synchronous.

---

## 9. SSE Protocol

### 9.1 Event flow

The `execute_code` tool uses the **existing** `tool_execution_*` events (unchanged from the old multi-tool protocol):

| Event | When | Data |
|---|---|---|
| `tool_execution_start` | Model emits `execute_code` | `{toolCallId, toolName: "execute_code", args: {code}}` |
| `tool_execution_update` | Tool progress (`queued`/`running`) | `{toolCallId, details: {type: "queued" | "running"}}` |
| `tool_execution_end` | Execution completes | `{toolCallId, isError, result: {content: [{text: "OK"}], details: {stdout, displays}}}` |

The `displays` array in the result details carries map data (markers, features, pairs, bounds) that the client renders as a `MapWidget`. Display data is collected during Monty execution and delivered atomically when the tool completes — NOT streamed as separate SSE events during execution.

### 9.2 Client rendering

- `tool_execution_start` with `toolName: "execute_code"` → show "Running code..." in timeline.
- `tool_execution_end` with `displays` containing markers/pairs → render `MapWidget` instead of `ToolCallCard`.
- `tool_execution_end` with no display data → render `ToolCallCard` with stdout.
- `tool_execution_end` with `isError: true` → render error card; model retries if coding error.

### 9.3 Backward compatibility

The existing event names (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`) are reused. No new event types were added. The web client's `chat-timeline.tsx` checks `toolName === "execute_code"` with display data to render a `MapWidget` vs a `ToolCallCard`. The existing `display_map` tool and its SSE details are deleted.

---

## 10. Security Model

### 10.1 Monty sandbox

- **Fresh Monty instance per execution** — no persistent kernel, each `execute()` call creates a new `Monty` instance.
- **No file system access.** Pixies mounts nothing.
- **No network access** from the sandbox. All I/O goes through injected host functions.
- **No process/subprocess/shell access.**
- **No imports.** Monty raises `ModuleNotFoundError` for any `import` statement.
- **No `__import__`, `eval`, `exec`, `compile`** — not defined in the sandbox.

### 10.2 Resource limits

```typescript
limits: {
    maxMemory: 64 * 1024 * 1024,       // 64 MB per execution
    maxDurationSecs: 30,                // 30s cumulative execution time per call
    maxRecursionDepth: 100,
}
```

### 10.3 Host function validation

Host functions validate their arguments at the TypeScript boundary. Invalid arguments raise Python exceptions the model can catch or let surface. Monty's Maps and tuple markers are converted to plain JS objects before reaching host functions (see `deepToPlainObject` in `monty-executor.ts`).

### 10.4 Rate limiting

Host functions inherit the existing OSM client rate limiting (p-queue, ADR-0005). The sandbox cannot bypass rate limits because it has no direct network access.

---

## 11. Performance

| Query type | LLM calls | Estimated wall-clock |
|---|---|---|
| Simple (1 hop) | 1 | 6–9s |
| Medium (2–3 hops) | 1 | 8–12s |
| Complex (4–5 hops) | 1 | 12–18s |
| Complex with retry | 2–3 | 15–25s |

Wall-clock is dominated by Overpass round-trips (~2–5s each). LLM code generation is ~3–5s per call. The model writes the full chain in one code block, so intermediate LLM round-trips are eliminated entirely.

---

## 12. Implementation Summary

### 12.1 Built

| Component | Location |
|---|---|
| Host functions (`geocode`, `find_features`, `filter`, `spatial_join`, etc.) | `packages/core/src/functions/host-functions.ts` |
| Filter logic (where-compiler, tag filter, sort, OSM number parsing) | `packages/core/src/functions/filter-logic.ts` |
| Brand/type dictionaries | `packages/core/src/functions/find-features-brands.ts`, `find-features-types.ts` |
| Overpass QL generator | `packages/core/src/functions/find-features-query.ts` |
| Geometry utilities (bounds, haversine) | `packages/core/src/functions/geometry.ts`, `haversine.ts` |
| `execute_code` tool module | `packages/core/src/tools/tool-execute-code.ts` |
| Monty executor (per-conversation, replay + caching) | `packages/server/src/sandbox/monty-executor.ts` |
| System prompt (tool-only, sync functions, chaining rule) | `packages/core/src/system-prompt.ts` |
| Web client: `MapWidget` from execute_code displays | `packages/web/src/components/chat/chat-timeline.tsx` |

### 12.2 Deleted

| Component | Why |
|---|---|
| `dependency-graph.ts` (TurnCoordinator, resolveRef, raceWithAbort) | Variables replace refs |
| `result-store.ts` (ResultStore) | Variables replace the store |
| `stored-element.ts` conversion functions | Host functions return plain dicts |
| `tool-geocode.ts`, `tool-reverse-geocode.ts`, `tool-query-osm.ts`, `tool-display-map.ts` | Logic moved to host functions |
| Old TypeBox schemas for deleted tools | No remaining callers |
| Ref error classes (UnknownRefError, CircularRefError, etc.) | No refs |
| `spatialJoinModule` (old framework wrapper) | Pure function in host-functions.ts |

### 12.3 Key deviations from the original spec

| Spec said | Reality | Why |
|---|---|---|
| `await`/`asyncio.gather` for parallelism | Synchronous calls only, no await | Monty external functions are sync globals; I/O is async internally |
| REPL session with `feedRun()` | Code replay + call caching | Monty v0.0.18 has no session/REPL API |
| Model writes NL answer after code | Model responds with tool calls only | Framework blocks text output in tool mode; map widget is the answer |
| Model calls `display()` explicitly | `find_features`/`spatial_join` auto-display | Simpler for the model — one less step to forget |
| New `code_execution_*` SSE events | Reuses `tool_execution_*` events | Less client-side churn; display data in result details |
| `maxDurationSecs: 10` | `maxDurationSecs: 30` | Multiple Overpass calls in one execution need more time |
| `.pyi` type stubs for Monty | Not built | Monty type-checking deferred; model writing errors caught by runtime |
| `class` SyntaxError | Monty allows classes | System prompt still says "do not define classes" |

---

## 13. Edge Cases

| Scenario | Handling |
|---|---|
| Model writes Python with a syntax error | Monty returns a `SyntaxError`. Model sees the traceback, fixes in next call. |
| Model writes `find_feature` (typo) | Monty raises `NameError`. Model fixes it. |
| Model writes an infinite loop | `maxDurationSecs` (30s) kills the worker. Model sees timeout error. |
| Model calls `find_features` with no `area` | Host function raises `ValueError("area is required")`. |
| Model calls `find_features` with a huge bbox | Overpass safety check rejects it with `ValueError("query area too large")`. |
| Overpass returns busy (`429`/`503`) | Host function raises error with `OVERPASS_BUSY_MESSAGE`. Model should not retry. |
| `geocode` returns ambiguous results | `alternatives` array populated. Model inspects and disambiguates. |
| `geocode` returns `None` | Model sees `None`. Retries with variant spelling or tells user via map. |
| Model tries `import` | Monty raises `ModuleNotFoundError`. |
| Model tries `eval()`, `__import__` | Not defined in sandbox. Raises `NameError`. |
| Session exceeds memory limit | Monty raises `ResourceError`. Executor returns error; next call is fresh. |
| Conversation evicted from LRU cache | Executor GC'd. Next message creates new executor; model re-fetches. |
| Server restarts mid-conversation | Executors not persisted. Model re-fetches. |
| Monty Maps/__tuple__ in function args | `deepToPlainObject()` converts to plain JS before host functions see them. |

---

## 14. Out of Scope

- **`spatial_join.within`** (polygon containment). Requires full geometry.
- **Session snapshotting across server restarts.** Monty supports `dump()`/`load()` but wiring to conversation persistence is deferred.
- **Routing / isochrones.** Future: add `route()` and `isochrone()` host functions.
- **Fine-tuning a model for code-action trajectories.** CodeAct released 7k trajectories for future use.
- **Monty WASM subpath** (`@pydantic/monty/wasm`). In-process, no crash isolation. Reserve for browser-only deployments.
- **Monty `typeCheck` with `.pyi` stubs.** The model writes correct function signatures from prompt examples; runtime errors catch the rest.
- **Streaming display during execution.** Display data is atomic at tool-completion, not live-streamed during code execution.

---

## 15. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Monty is pre-1.0** (API churn) | Medium | Pinned `0.0.18`. Executor wrapped behind `monty-executor.ts`. `runMontyLoop()` is our own loop, not Monty's `runMontyAsync`. |
| **Code replay overhead** (re-running all previous code) | Low | Results cached by function+args. Replay is instant — no network. Only for multi-turn conversations; most queries are 1-turn. |
| **Model writes buggy Python** | Medium | Runtime errors return tracebacks. Explicit retry instruction. Most errors are fixable in one retry. |
| **Variable hallucination** | Medium | Functions auto-print summaries. Prompt: "inspect results with print() before using them." `geocode` returns `alternatives` for ambiguous queries. |
| **No parallelism** (can't run `find_features` for 2 types simultaneously) | Low | Overpass latency dominates execution time. Sequential calls within one block are still faster than multi-turn round-trips. |
| **Model over-generates** | Low | Prompt: "write minimal code." Compact examples. Model adapts code length to query. |
| **Monty Maps in arguments** (Python dict → JS Map) | Fixed | `deepToPlainObject()` converts Maps to plain objects before host functions see them. |
| **Monty `runMontyAsync` error-handling bug** | Fixed | Custom `runMontyLoop()` keeps `resume()` outside the external-function try-catch. |

---

## 16. Research References

### Primary (design-defining)

1. **CodeAct** — Wang et al. (2024). "Executable Code Actions Elicit Better LLM Agents." ICML. arXiv:2402.01030.
2. **Spatial-RAG** — Yu et al. (2025). "Spatial-RAG." arXiv:2502.18470.
3. **CRAG** — Yan et al. (2024). "Corrective RAG." arXiv:2401.15884.
4. **Dissecting Agentic RAG** — Shaikh (2026). arXiv:2606.21553.
5. **GROKE** — Shami et al. (2026). arXiv:2601.07375.

### Supporting

6. **Reliable Code-as-Policies** — Ahn et al. (2025). NeurIPS. arXiv:2510.21302.
7. **PAL** — Gao et al. (2022). arXiv:2211.10435.
8. **Code as Policies** — Liang et al. (2022). arXiv:2209.07753
9. **LLMCompiler** — Kim et al. (2024). ICML. arXiv:2312.04511. *The DAG+refs approach that failed in pixies.*

### Systems

10. **Monty** — Pydantic. `@pydantic/monty` v0.0.18. *Sandboxed Python for LLM code execution.*
