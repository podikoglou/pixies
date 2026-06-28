# Spec: REPL-Style Code Agent for Spatial Queries

**Status:** Experiment — proposed, pre-implementation
**Supersedes:** PR #245 (dependency-resolved tool batches), ADR-0013
**Research basis:** CodeAct (ICML 2024), Spatial-RAG (arXiv 2502.18470), CRAG (arXiv 2401.15884), GROKE (arXiv 2601.07375), Dissecting Agentic RAG (arXiv 2606.21553)

---

## 1. TL;DR

Replace the seven-tool + dependency-layer architecture with a **single `execute_code` tool backed by a sandboxed Python session (Monty)**. The model writes Python that calls our spatial host functions. Variables handle data flow — no refs, no coordinator, no store. The session is persistent (REPL-style): the model inspects results, adjusts queries, and iterates across feeds. Two to four LLM calls per query regardless of complexity.

---

## 2. Problem

The current architecture (PR #245, issue #244) failed in production for the reasons issue #244's Counterarguments section predicted:

1. **The model cannot use the ref mechanism.** It hallucinated tool-call IDs, never emitted multi-tool batches, and abandoned the new tools entirely after two `UnknownRefError` failures.
2. **The `ResultStore` was never written to.** Cross-turn refs are 100% broken in production — no tool's `execute` path calls `ctx.store.set(...)`.
3. **`geocode`'s `executionMode: "sequential"` poisons any batch** containing it — the framework forces the entire batch sequential, breaking the coordinator.
4. **Content dumps waste context.** `find_features` dumps 50 elements × ~300 chars of tag soup per call. The model called it 3× in the failure trace → ~12K tokens of pharmacies.
5. **The entire dependency layer is dead code in production.** Tests pass; users get nothing.

---

## 3. Architecture

### 3.1 The REPL loop

```
User query
    │
    ▼
┌──────────────────────────────────┐
│  LLM call #1                     │  Model writes Python code
│  System prompt + query + history │  (one or more host-function calls)
│  → execute_code(code)            │
└──────────────┬───────────────────┘
               │ code string
               ▼
┌──────────────────────────────────┐
│  Monty session (persistent)      │  No LLM in the loop
│                                  │
│  session.feedRun(code)           │  Variables survive across feeds.
│  ├─ geocode() → Nominatim        │  Host functions do all I/O.
│  ├─ find_features() → Overpass   │  display() pushes SSE events
│  ├─ filter() → in-memory         │  to the client during execution.
│  ├─ spatial_join() → in-memory   │
│  └─ display() → SSE to client    │
│                                  │
│  → stdout + errors captured      │
└──────────────┬───────────────────┘
               │ stdout / traceback
               ▼
┌──────────────────────────────────┐
│  LLM call #2 (or #3, #4...)     │  Model sees stdout, decides:
│  Sees: stdout from last feed    │  - write more code (another feed)
│                                 │  - write the final NL answer
└──────────────────────────────────┘
```

The model drives the loop. Each LLM call produces one `execute_code` tool call (a "feed"). The session persists between feeds — variables from feed 1 are alive in feed 3. The model inspects results with `print()`, adjusts if needed, and writes its answer when done.

**Simple query:** 2 LLM calls (one code feed + one answer).
**Complex query with iteration:** 3–4 LLM calls (2–3 feeds + answer). Each feed is short (2–5 lines, ~50 tokens). Far cheaper than the current N-round-trip pattern where each turn carries full conversation history.

### 3.2 Why this works (research basis)

| Design decision | Evidence |
|---|---|
| Code actions, not structured tool calls | CodeAct (ICML 2024): +20.7 pts over JSON on complex multi-tool tasks, 2.1 fewer turns. Variables are the data-flow mechanism — free, no refs. |
| REPL loop (persistent session, not one-shot) | CodeAct §A: the pattern is multi-turn interactive, NOT single-shot codegen (PAL, Code-as-Policies). OpenAI Code Interpreter uses a persistent kernel. |
| Model inspects results before reusing | Reliable Code-as-Policies (NeurIPS 2025): #1 failure mode is "variable hallucination." Fix: force inspection. `print()` is the inspection mechanism. |
| Smart functions handle relaxation internally | CRAG (arXiv 2401.15884): retrieval failure detection + correction is a system layer. "Indiscriminately incorporating bad retrieval is worse than no retrieval." |
| Budgeted summaries, not full dumps | Real-time Spatial RAG (arXiv 2505.02271): "LLMs are incapable of handling large volumes, even within context window." |
| 2 LLM calls, no model between steps | Dissecting Agentic RAG (arXiv 2606.21553): "the model is not queried between retrieval steps." 2 hops capture 95% of gains. |
| Decompose into typed function calls, not monolithic queries | Spatial-RAG (arXiv 2502.18470): "LLMs struggle to construct complete spatial queries." Typed function calls are the decomposition. |
| Python, not JavaScript | Python is the canonical language for "LLM writes code that calls tools" (smolagents, Claude code execution, Pydantic AI code-mode). 3× more token-efficient than JSON for the same semantics. |

---

## 4. Host Function API

The model sees one tool: `execute_code(code: str)`. Inside the Monty sandbox, these host functions are available. Each is an async JS function on the server that Monty calls transparently via `newAsyncifiedFunction`.

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
    "importance": 0.8,
    "display_name": "Tour Eiffel, 5, Avenue Anatole France, Quartier du Gros-Caillou, Paris 7e Arrondissement, ...",
    "bbox": [48.857, 2.293, 48.859, 2.296],  # present for area-returning places (cities, countries)
    "alternatives": [  # present when ≥2 strong matches exist (ambiguity signal)
        {"name": "Springfield", "lat": 37.2, "lon": -93.3, "importance": 0.7, "display_name": "Springfield, Missouri, USA"}
    ]
}
```

**Auto-printed summary on call:** `geocode("Eiffel Tower, Paris") → Tour Eiffel (48.858, 2.295) [tower, importance=0.8]`

The model should inspect `alternatives` when present and disambiguate if the top result is ambiguous.

### 4.2 `reverse_geocode`

```python
reverse_geocode(lat: float, lon: float) -> list[dict]
```

Returns up to 5 nearby places from Nominatim. Same dict shape as `geocode` (without `alternatives`).

### 4.3 `find_features`

```python
find_features(
    *,
    types: list[str] | None = None,       # ["pharmacy", "restaurant", "LIDL"]
    tags: list[dict] | None = None,        # [{"key": "amenity", "value": "pharmacy"}]
    area: dict,                            # see Area formats below
    name: str | None = None,               # case-insensitive regex on the name tag
    limit: int = 200,                      # max features to return
) -> dict
```

Primary OSM feature search via Overpass. `types` resolve to OSM tag clauses via the existing type/brand dictionary. Unknown types fall back to case-insensitive name match.

**Area formats (exactly one required):**

| Key | Value | Resolves to |
|---|---|---|
| `"place"` | `str` — `"Paris, France"` | Geocoded bbox (or around-point with `expand`) |
| `"around"` | `dict \| feature` — `{"lat": float, "lon": float, "radius": int}` or a geocode/feature dict (lat/lon extracted) + `"radius"` | Overpass `(around:radius,lat,lon)` |
| `"bounds"` | `dict` — `{"minlat", "minlon", "maxlat", "maxlon"}` | Overpass bbox |
| `"features"` | `list[dict]` — prior result's feature list | Bounding box of the features, expanded by 250m margin |

The `"features"` form replaces the old `queryRef` — the model passes the actual data (a Python variable), not a ref string.

**Return shape:**
```python
{
    "features": [
        {
            "id": "node/259546329",
            "name": "Pharmacie Lecourbe Cambronne",   # None if unnamed
            "lat": 48.8427695,
            "lon": 2.3027722,
            "tags": {"amenity": "pharmacy", "opening_hours": "Mo-Fr 08:30-20:00; Sa 09:00-20:00"},
        },
        # ... up to `limit` features
    ],
    "count": 118,            # total features found by Overpass
    "truncated": True,       # True if `features` was capped at `limit`
    "relaxed": False,        # True if auto-relaxation was applied (see §6)
    "note": None,            # human-readable note when relaxed or on error
}
```

**Auto-printed summary:** `find_features(types=["pharmacy"], around=Tour Eiffel, radius=2000m) → 118 features (20 shown)`

### 4.4 `filter`

```python
filter(
    features: list[dict],                # a feature list from find_features / geocode
    *,
    where: str | None = None,            # "opening_hours =~ /24/7/ AND name !~ /test/"
    sort_by: str | None = None,          # "-population" (descending) or "name"
    limit: int | None = None,
    distinct: bool = False,
) -> list[dict]
```

Synchronous in-memory predicate over a feature list. The `where` clause supports AND/OR, parentheses, and: `=`, `!=`, `<`, `>`, `<=`, `>=`, `=~` (regex), `!~`, `IS NULL`, `IS NOT NULL`. Numeric comparisons parse OSM's loose formats (`"30 000"`, `"30,000"`, `"~30000"`).

Returns the filtered list (same feature dict shape). No wrapping — it's a plain list operation.

### 4.5 `spatial_join`

```python
spatial_join(
    *,
    points: list[dict],                  # feature list (left side)
    targets: list[dict],                 # feature list (right side)
    operation: str,                      # "near" | "nearest"
    radius: int,                         # metres
) -> list[dict]
```

Synchronous haversine join. Returns pairs sorted by distance:

```python
[
    {
        "point": {"id": "way/5013364", "name": "Tour Eiffel", "lat": 48.858, "lon": 2.294, ...},
        "target": {"id": "node/829526567", "name": "Pharmacie Anglaise des Champs-Élysées", "lat": 48.870, "lon": 2.305, ...},
        "distance": 1623,                # metres (rounded)
    },
    ...
]
```

- `"near"`: all targets within radius of each point (many-to-many). Capped at 1000 pairs.
- `"nearest"`: single closest target per point within radius (one-to-one).

### 4.6 `display`

```python
display(
    *,
    markers: list[dict] | None = None,       # [{"lat": float, "lon": float, "label": str}]
    features: list[dict] | None = None,      # feature list → markers
    pairs: list[dict] | None = None,         # spatial_join output → markers + connecting lines
    bounds: dict | None = None,              # {"minlat", "minlon", "maxlat", "maxlon"} viewport
) -> None
```

Fire-and-forget: pushes an SSE event to the client with map data. Returns `None`. The model calls this during code execution — the map renders live as the code runs. Multiple calls append to the current map view.

### 4.7 `overpass_query` (escape hatch)

```python
overpass_query(query: str) -> dict
```

Raw Overpass QL. Returns `{"elements": [...], "count": int}`. The system prompt says: use `find_features` by default; use `overpass_query` only for queries `find_features` cannot express (recursive relations, historical, complex cross-tag boolean logic).

### 4.8 Utility functions

```python
haversine(a: dict, b: dict) -> int        # metres between two {lat, lon} dicts
bounds_of(features: list[dict]) -> dict   # {"minlat", "minlon", "maxlat", "maxlon"}
print(*args) -> None                       # captured stdout, shown to model
len(x) -> int                              # built-in
```

---

## 5. Session Model

### 5.1 Lifecycle

Each conversation gets one Monty session, created lazily on the first `execute_code` call. The session persists for the conversation's in-memory lifetime (managed by the existing 24h LRU cache in `@pixies/server`). When the conversation is evicted, the session is disposed.

**Session state:**
- Python variables (the scratchpad — all prior results are alive and referenceable)
- Cumulative execution time budget (accumulates across feeds, per Monty's `maxDurationSecs`)
- Memory usage (per Monty's `setMemoryLimit`)

### 5.2 Feed loop

Each assistant message that includes an `execute_code` tool call triggers one `session.feedRun(code)`:

1. Server extracts the code string from the tool call arguments.
2. Server calls `session.feedRun(code, { externalFunctions, printCallback, limits })`.
3. Monty executes the code. Host functions fire as called. `display()` pushes SSE events.
4. Monty returns: stdout + result (or traceback on error).
5. Server wraps the output as the tool result and returns it to the framework.
6. Framework feeds the tool result back to the model → next assistant message.

### 5.3 Concurrency

The server already enforces one prompt per conversation (concurrent POSTs get 409). Session access is single-threaded per conversation. The Monty pool handles multiple concurrent conversations (multiple sessions checked out from the pool).

### 5.4 Conversation persistence

The Python session is NOT persisted across server restarts. On restart, a conversation that resumes gets a fresh session — variables are lost. The model sees "session reset" and re-fetches if needed. This matches the current behaviour where tool results are not persisted across restarts.

---

## 6. Progressive Relaxation

Implemented inside `find_features`, invisible to the model's code (CRAG pattern, arXiv 2401.15884). The model does NOT write retry loops.

**Relaxation schedule when Overpass returns 0 results:**

| Step | Action |
|---|---|
| 0 | Original query as-is |
| 1 | Expand `around` radius × 1.5 |
| 2 | Expand `around` radius × 2 |
| 3 | Expand `around` radius × 3 |
| 4 | Broaden tag filters: exact → iregex (e.g., `amenity=pharmacy` → `amenity~pharmacy`) |
| 5 | Drop the most restrictive tag clause |

At each step, if results are found, return immediately with `relaxed: True` and `note: "expanded radius from {original}m to {actual}m"` (or equivalent). The model sees the note and can mention it in the answer.

If all steps exhaust, return `{"features": [], "count": 0, "relaxed": True, "note": "no results found after broadening search"}`.

**When NOT to relax:** if the query is genuinely expected to return 0 (e.g., `find_features(types=["nonexistent_type"], ...)`), relaxation won't help. The function returns 0 after one relaxation step. The model sees the empty result and adjusts its query in the next feed.

---

## 7. Context Budget

### 7.1 Summary-first returns

Host functions auto-print a one-line summary to stdout on each call. The model sees the summary, not the full data, unless it explicitly inspects:

```
geocode("Eiffel Tower, Paris") → Tour Eiffel (48.858, 2.295) [tower, importance=0.8]
find_features(types=["pharmacy"], around=Tour Eiffel, radius=2000m) → 118 features (20 shown)
filter(118 features, where="opening_hours =~ /24/7/") → 3 features
spatial_join(1 point, 3 targets, nearest, 2000m) → 1 pair (best: 847m)
display(pairs=1)
```

The model sees ~5 lines of stdout per feed. The full data is in the Python variables — the model can `print(pharmacies["features"][0])` to inspect a specific feature.

### 7.2 Feature truncation

`find_features` returns at most `limit` features in the `features` array (default 200). The full `count` is always included so the model knows the true result size. If `count > limit`, `truncated: True`.

The auto-printed summary shows the first 3 feature names + the count, not the full list.

### 7.3 No pipe-delimited dumps

The current architecture's `formatContentLines` (50-line pipe-delimited tag soup) is eliminated. The model sees structured JSON only when it explicitly inspects, and summaries by default.

---

## 8. System Prompt

### 8.1 Structure

```
1. Role + capabilities (unchanged from current — "You are Pixies, an AI agent that answers questions about places using OpenStreetMap data.")

2. Available functions (signatures + one-line descriptions)
   ~150 tokens

3. Examples (2-3 patterns)
   ~200 tokens

4. OSM-specific guidance (name variants, diacritics, permalinks, disambiguation)
   ~800 tokens (unchanged from current)

5. Coding guidance ("write minimal code", "inspect results with print()", "use asyncio.gather for parallel calls")
   ~100 tokens
```

**Estimated total:** ~1,400 tokens (system prompt) + ~100 tokens (one tool schema: `execute_code`) = ~1,500 tokens.

Current architecture: ~2,000 tokens (system prompt) + ~2,100 tokens (7 tool schemas) = ~4,100 tokens.

### 8.2 Example block

```
Example — "nearest 24/7 pharmacy to the Eiffel Tower":

    tower = await geocode("Eiffel Tower, Paris")
    pharmacies = await find_features(
        types=["pharmacy"],
        area={"around": tower, "radius": 2000},
    )
    open_24_7 = filter(pharmacies["features"], where="opening_hours =~ /24/7|00:00-24:00/")
    nearest = spatial_join(points=[tower], targets=open_24_7, operation="nearest", radius=2000)
    display(pairs=nearest)

Example — "IKEAs near LIDLs in towns under 30k near Stockholm":

    stockholm = await geocode("Stockholm, Sweden")
    towns = await find_features(types=["town"], area={"around": stockholm, "radius": 50000})
    small_towns = filter(towns["features"], where="population < 30000")
    lidls, ikeas = await asyncio.gather(
        find_features(types=["LIDL"], area={"features": small_towns}),
        find_features(types=["IKEA"], area={"features": small_towns}),
    )
    pairs = spatial_join(points=ikeas["features"], targets=lidls["features"], operation="near", radius=2000)
    display(pairs=pairs)
```

### 8.3 Coding guidance

```
Write Python to answer the question. Use the provided functions.

Rules:
- Write minimal code for the query. Don't add error handling unless needed.
- Inspect results with print() or len() before using them.
- Use asyncio.gather() to parallelise independent calls.
- Call display() to show results on the map.
- Use functions and plain dicts. Do not define classes.
- If a query returns 0 results, broaden the search (larger radius, fewer tags) and try again.
- Use await for geocode, find_features, overpass_query. filter and spatial_join are synchronous.
```

---

## 9. SSE Protocol Changes

### 9.1 New events

| Event | Trigger | Data |
|---|---|---|
| `code_execution_start` | Model emits `execute_code` | `{toolCallId, code}` |
| `code_execution_update` | Host function starts/completes | `{toolCallId, function, status, summary}` |
| `display` | `display()` called during execution | `{markers, features, pairs, bounds}` (same shape as current `display_map` details) |
| `code_execution_end` | Feed completes | `{toolCallId, stdout, isError}` |

### 9.2 Backward compatibility

The existing `tool_execution_start`, `tool_execution_update`, `tool_execution_end` events are replaced by the `code_execution_*` variants. The web client updates its reducer to handle the new event names. The `display` event replaces the current `display_map` tool's `details` payload — same data shape, different delivery mechanism (pushed during execution, not in a tool result).

The `text_delta`, `message_start`, `message_end`, `done`, and `error` events are unchanged.

### 9.3 Client rendering

- `code_execution_start` → show "Running code..." indicator in the chat timeline.
- `code_execution_update` → show progress ("Geocoding...", "Searching Overpass...", "Filtering...").
- `display` → render markers/polylines on the map widget immediately.
- `code_execution_end` → show stdout summary in the timeline (collapsible).
- Model's final text → render as the assistant message.

---

## 10. Security Model

### 10.1 Monty sandbox

- **Subprocess pool** (default napi binding): worker crash raises `MontyCrashedError`, pool replaces the worker, host process is unaffected.
- **No file system access** unless explicitly mounted. Pixies mounts nothing.
- **No network access** from the sandbox. All I/O goes through injected host functions (`geocode`, `find_features`, `overpass_query`).
- **No process/subprocess/shell access.**
- **No environment variables** (workers spawn with empty env).
- **No third-party imports** (stdlib allowlist only: `asyncio`, `datetime`, `json`, `math`, `re`, `typing`).

### 10.2 Resource limits

```typescript
limits: {
    maxMemory: 64 * 1024 * 1024,       // 64 MB per session
    maxDurationSecs: 10,                // 10s cumulative execution time per session
    maxRecursionDepth: 100,
}
```

Pool-level `requestTimeout: 30` (wall-clock backstop — kills the worker PID if it wedges).

### 10.3 Host function validation

Host functions validate their arguments (same TypeBox schemas as today, applied inside the function before doing work). Invalid arguments raise `TypeError` or `ValueError` — Python exceptions the model can catch or let surface.

### 10.4 Rate limiting

Host functions inherit the existing OSM client rate limiting (p-queue, ADR-0005). The sandbox cannot bypass rate limits because it has no direct network access — every request goes through the clients.

---

## 11. Performance Targets

| Query type | Example | LLM calls | Estimated wall-clock |
|---|---|---|---|
| Simple (1 hop) | "bakeries near Booking.com HQ" | 2 (code + answer) | 6–9s |
| Medium (2–3 hops) | "nearest 24/7 pharmacy to the Eiffel Tower" | 2 (code + answer) | 8–12s |
| Complex (4–5 hops) | "IKEAs near LIDLs in towns under 30k near Stockholm" | 2 (code + answer) | 12–18s |
| Complex with iteration | "Costa Coffee drive-through near a rental office in London" (adjusts if 0 results) | 3–4 (2 feeds + answer) | 15–22s |

Wall-clock is dominated by Overpass round-trips (~2–5s each). LLM generation is ~3–5s per call. Code execution overhead is negligible (~0.06ms startup + host function call overhead).

**Comparison to current architecture:** complex queries currently take 20–30s (5+ LLM round-trips at ~2s each, plus tool execution). This spec targets 12–18s for the same queries — a 1.5–2× improvement — because intermediate LLM round-trips are eliminated.

---

## 12. Migration Plan

### 12.1 What's built new

| Component | Location | Description |
|---|---|---|
| Monty pool + session manager | `packages/server/src/sandbox/pool.ts` | Owns `Monty.create()`, checkout/dispose, session-per-conversation mapping |
| Host function bridge | `packages/server/src/sandbox/functions/*.ts` | Wraps existing OSM client logic as async functions injectable into Monty |
| `execute_code` tool | `packages/core/src/tools/tool-execute-code.ts` | Single tool: takes `code: str`, feeds to session, returns stdout |
| `.pyi` type stubs | `packages/server/src/sandbox/stubs.pyi` | Generated from host function signatures; passed to Monty's `typeCheck` |
| SSE event types | `packages/core/src/sse-events.ts` | `code_execution_start/update/end`, `display` events |
| Web reducer updates | `packages/web/src/lib/chat-reducer.ts` | Handle new SSE events |

### 12.2 What's reused

| Component | Why it stays |
|---|---|
| `NominatimClient`, `OverpassClient` | Unchanged — host functions call them |
| Rate limiting (p-queue, ADR-0005) | Unchanged — lives in the clients |
| Type/brand dictionary (`find-features-types.ts`, `find-features-brands.ts`) | Unchanged — used by the `find_features` host function |
| Overpass QL generator (`find-features-query.ts`) | Unchanged — used by `find_features` |
| Where-clause parser (`tool-filter.ts` parser) | Extracted as a pure function, used by the `filter` host function |
| Haversine (`tool-spatial-join.ts`) | Extracted as a pure function, used by `spatial_join` |
| Token budget (`token-budget.ts`) | Unchanged — still trims old conversation turns |
| Conversation persistence (SQLite + LRU cache) | Unchanged — sessions piggyback on conversation lifecycle |
| Map widget (`map-widget.tsx`) | Mostly unchanged — renders markers/polylines from `display` events |

### 12.3 What's deleted

| Component | Why |
|---|---|
| `dependency-graph.ts` (TurnCoordinator, resolveRef, raceWithAbort) | Variables replace refs |
| `result-store.ts` (ResultStore) | Variables replace the store |
| `stored-element.ts` (overpassEntryToStored, etc.) | Host functions return plain dicts |
| `errors.ts` additions (UnknownRefError, CircularRefError, UpstreamFailedError) | No refs → no ref errors |
| 7-tool schema definitions | Replaced by one `execute_code` tool |
| Tool-selection / dependency-planning system prompt sections | Replaced by function docs + examples |
| `tool-geocode.ts`, `tool-reverse-geocode.ts` framework tool wrappers | Logic moves to host functions; framework wrappers deleted |
| `tool-query-osm.ts` framework tool wrapper | Becomes `overpass_query` host function |
| `tool-display-map.ts` framework tool wrapper | Becomes `display` host function + SSE push |

### 12.4 Implementation order

1. `bun add @pydantic/monty` (pin `0.0.18`) in `@pixies/server`
2. Build the Monty pool + session manager
3. Extract host functions from existing tool implementations (strip coordinator/store integration)
4. Build the `execute_code` tool
5. Write the system prompt + `.pyi` stubs
6. Update SSE event types
7. Update web client (chat reducer, map widget)
8. End-to-end test with the pharmacy query
9. Delete the old tool infrastructure

---

## 13. Edge Cases

| Scenario | Handling |
|---|---|
| Model writes Python with a syntax error | Monty returns a `SyntaxError`. Model sees the traceback, fixes the code in the next feed. |
| Model writes `find_feature` (typo, missing `s`) | Monty's type checker (`ty`) catches the undefined name before execution. Model sees the error, fixes it. |
| Model writes an infinite loop | `maxDurationSecs` (10s cumulative) kills the worker. Model sees a timeout error. |
| Model writes `while True: pass` (CPU burn) | Same — `maxDurationSecs` kills the worker. Pool replaces it. |
| Model calls `find_features` with no `area` | Host function raises `ValueError("area is required")`. Model sees the error. |
| Model calls `find_features` with a huge bbox (planet-wide) | Overpass safety check (existing) rejects it. Host function raises `ValueError("query area too large")`. |
| Overpass returns busy (`429` or `503`) | Host function raises `OverpassBusy` exception. Model can catch it or let it surface. System prompt says: "treat as terminal — tell the user Overpass is temporarily unavailable." |
| `geocode` returns an ambiguous result (multiple Springfields) | `alternatives` array is populated. Model inspects and disambiguates. |
| `geocode` returns `None` (no match) | Model sees `None` and either retries with a variant spelling or tells the user. |
| Model defines a `class` | Monty raises `SyntaxError` (classes not yet supported). System prompt warns: "do not define classes." |
| Model tries to `import os` or `import socket` | Monty raises `ModuleNotFoundError` (not in allowlist). |
| Model tries to access `__import__` or `eval` | Not defined in the sandbox. Raises `NameError`. |
| Session exceeds memory limit (64 MB) | Monty raises `ResourceError`. Session is discarded. Next feed gets a fresh session. |
| Conversation evicted from LRU cache | Session is disposed. Next message to that conversation creates a new session. Model re-fetches if needed. |
| Server restarts mid-conversation | Sessions are not persisted. Model re-fetches. Same as current behaviour for tool results. |
| Two feeds run concurrently on the same session | Server enforces one prompt per conversation (409 on concurrent POST). Session access is single-threaded. |

---

## 14. Out of Scope

- **`spatial_join.within`** (polygon containment). Requires full geometry (`out geom;`). Same as issue #244.
- **Session snapshotting across server restarts.** Monty supports `dump()`/`load()` but wiring it to conversation persistence is a future optimisation.
- **`execution_plan` SSE event.** No longer needed — the code IS the plan.
- **Routing / isochrones.** Future: add `route()` and `isochrone()` host functions. No architecture change required.
- **Fine-tuning a model for code-action trajectories.** CodeAct released 7k trajectories; pixies may curate its own if open-model support is needed.
- **Monty WASM subpath** (`@pydantic/monty/wasm`). In-process, no crash isolation. Reserve for browser-only deployments if ever needed.

---

## 15. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Monty is pre-1.0** (API churn) | Medium | Pin `0.0.18`. Wrap pool/session behind one internal module (`sandbox/pool.ts`). Budget one migration when 0.1 lands. |
| **No `class` in sandbox** | Low | System prompt: "use functions and plain dicts." The `web_scraper` example shows sonnet-4.5 complying. LLM glue rarely needs classes. |
| **Model writes buggy Python** | Medium | Monty's type checker catches errors pre-execution. Runtime errors return tracebacks. The REPL loop lets the model fix one line, not the whole script. |
| **Variable hallucination** (model assumes result content) | Medium | Functions auto-print summaries the model must read. System prompt: "inspect results with print() before using them." `geocode` returns `alternatives` for ambiguous queries. |
| **Monty worker binary platform mismatch in Docker** | Low | Use `@pydantic/monty-linux-x64-gnu`. Verify architecture at Docker build time. |
| **Model over-generates** (writes 30 lines for a 3-line query) | Low | System prompt: "write minimal code." Show compact examples. The model adapts code length to query complexity. |
| **Cumulative execution time across feeds** | Low | Monty's `maxDurationSecs` accumulates across feeds. 10s is sufficient for ~20 host function calls (dominated by Overpass latency, not compute). |

---

## 16. Research References

### Primary (design-defining)

1. **CodeAct** — Wang et al. (2024). "Executable Code Actions Elicit Better LLM Agents." ICML. arXiv:2402.01030. *Code actions beat JSON by +20.7 pts on complex multi-tool tasks. Variables are the data-flow mechanism.*
2. **Spatial-RAG** — Yu et al. (2025). "Spatial-RAG." arXiv:2502.18470. *Decompose geospatial QA into typed components. LLMs can't write monolithic spatial queries.*
3. **CRAG** — Yan et al. (2024). "Corrective RAG." arXiv:2401.15884. *Retrieval failure detection + correction is a system layer, not the model's job.*
4. **Dissecting Agentic RAG** — Shaikh (2026). arXiv:2606.21553. *2 retrieval hops capture 95% of gains. No LLM between steps.*
5. **GROKE** — Shami et al. (2026). arXiv:2601.07375. *JSON outperforms text/visual for spatial data in LLM context.*
6. **Real-time Spatial RAG** — Campo et al. (2025). arXiv:2505.02271. *"LLMs can't handle large volumes even within context window." System must pre-filter.*

### Supporting

7. **Reliable Code-as-Policies** — Ahn et al. (2025). NeurIPS. arXiv:2510.21302. *#1 failure: variable hallucination. Fix: force inspection.*
8. **PAL** — Gao et al. (2022). arXiv:2211.10435. *Offload computation to interpreter: +15% over chain-of-thought.*
9. **Code as Policies** — Liang et al. (2022). arXiv:2209.07753. *Spatial reasoning via code + geometry libs is a sweet spot.*
10. **Adaptive-RAG** — Jeong et al. (2024). arXiv:2403.14403. *Route by query complexity. Simple queries need less work.*
11. **IRCoT** — Trivedi et al. (2023). arXiv:2212.10509. *Multi-hop retrieval: each step's output feeds the next.*
12. **LLMCompiler** — Kim et al. (2024). ICML. arXiv:2312.04511. *DAG + refs approach — the counterpoint that failed in pixies.*

### Systems

13. **Monty** — Pydantic. https://github.com/pydantic/monty. `@pydantic/monty` v0.0.18. *Purpose-built sandboxed Python for LLM code execution.*
14. **OpenAI Code Interpreter / Containers** — persistent kernel, no outbound network, controlled egress.
15. **TaskWeaver** — Microsoft. https://github.com/microsoft/TaskWeaver. *Code-first agent framework with plugins-as-functions.*
