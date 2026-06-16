---
name: extract-components
description: Analyze React/TSX code to identify fragments that should be extracted into their own components. Classifies candidates as either UI primitives (abstract, generic, reusable anywhere) or feature components (domain-specific, composed from primitives). Use when asked to review component structure, find extraction opportunities, audit for god components, or "does this need to be its own component?"
---

# Extract Components

## Quick start

Provide a file path or paste code. The skill analyzes it for extraction candidates.

## Component classification

|                         | UI primitive                                   | Feature component                           |
| ----------------------- | ---------------------------------------------- | ------------------------------------------- |
| **Location**            | `components/ui/`                               | `components/<domain>/`                      |
| **Domain logic**        | None — purely presentational                   | Domain-specific state, hooks, or context    |
| **Props**               | Abstract (`variant`, `size`, `children`)       | Domain-typed (`conversationId`, `message`)  |
| **Import footprint**    | Generic utils only (`cn`, `cva`)               | May import domain types, API clients, state |
| **Reuse potential**     | Any feature, any project                       | Within the domain, possibly across features |
| **Examples**            | `Button`, `Badge`, `Skeleton`                  | `OsmDisclaimer`, `ChatInput`, `MapWidget`   |

## UI primitive — extraction signals

Extract when the fragment meets **2+** of these:

1. **Repeated visual pattern** — same className combos appear 3+ times across files
2. **Abstractable props** — all props can be named generically (no domain nouns)
3. **Single visual concern** — does one presentational thing (a status dot, a crossfade, an empty state placeholder)
4. **No side effects** — no data fetching, no context consumption, no mutations
5. **Variant-driven** — the differences between instances are categorical (size, color, state) — a `cva` would cleanly model them

Common signals in this codebase:
- Icon crossfade pattern (`<span>` with two absolute-positioned icons, scale/opacity transitions)
- Repeated layout wrappers (`flex items-center gap-2`, `rounded-md border`)
- Status indicators composed from primitives but duplicated inline

## Feature component — extraction signals

Extract when the fragment meets **2+** of these:

1. **Self-contained state** — owns `useState`, `useRef`, `useEffect`, or custom hooks
2. **Coherent domain concept** — represents a recognizable thing in the domain (a map widget, a disclaimer banner, a welcome screen)
3. **Used 2+ times** OR **parent exceeds ~150 lines** and extraction clarifies intent
4. **Clear interface boundary** — a few props hide internal complexity from the parent
5. **Independently testable** — could render in isolation with mock props

## When NOT to extract

| Anti-pattern                     | Why                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------- |
| **Props passthrough**            | Component just spreads props to a single child — adds indirection without value  |
| **Single-use wrapper**           | A `<div>` around one element, used once, no state — just a div with extra steps  |
| **Shared mutable state**         | Two would-be siblings that mutate the same state — keep them together            |
| **Premature abstraction**        | Pattern appears once; wait for the second occurrence                             |
| **Overly specific UI primitive** | Props contain domain nouns — it's a feature component, not a primitive           |

## Workflow

1. **Read the file(s)** in full
2. **Partition the JSX** into logical fragments (visual sections, repeated patterns, self-contained chunks)
3. **Classify each fragment** against the signal tables above
4. **Filter out** anti-patterns
5. **Report** candidates with classification, rationale, and suggested location

## Output format

Present as a markdown table with classification, fragment description, and suggested file path:

```
## Extraction candidates — <file>

### UI primitives
| Fragment | File:line | Rationale | Suggested path |
| --- | --- | --- | --- |
| Crossfade icon wrapper | file.tsx:58-72 | Duplicated pattern (also in other-file.tsx:46-65); abstractable to `status: "a" \| "b"` | `components/ui/crossfade-icon.tsx` |

### Feature components
| Fragment | File:line | Rationale | Suggested path |
| --- | --- | --- | --- |
| Empty map state | file.tsx:19-23 | Coherent domain concept with its own styling; clarifies parent intent | `components/chat/map-empty-state.tsx` |
```

If no candidates found: `## No extraction candidates — everything is appropriately scoped.`

Include a **Not extracted** section for fragments that look extractable but fail one of the anti-pattern checks, with a brief explanation of why.

Group by classification first, then by file. Only include tables for categories that have findings — empty tables add noise.
