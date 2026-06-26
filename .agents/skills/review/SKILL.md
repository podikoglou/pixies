---
name: review
description: Review PRs, branches, or commits. Checks out the target locally, reads PR context via gh CLI, and audits code quality, architecture, DRY, test coverage, and bugs. Use when asked to review a PR, branch, commit, or any code change.
---

# Code Review

## Setup

Parse the input. PR number/URL → `gh pr checkout`. Branch name → diff against `main` and checkout. Commit hash → show that commit. No input → uncommitted changes.

**Always check out the target.** For PRs, read `gh pr view` first for intent, and read the linked issue (and any PRD it references) for planning context — it carries the decisions and saves re-discovering them.

Read every changed file **in full** — diffs are insufficient.

## Checks

Run these in order. **A single blocking finding in any check means the verdict is "needs fixes".** There is no "merge with suggestions". If something should be fixed, it blocks merge.

### 1. Architecture and separation of concerns

This is a monorepo with four packages:

- **`@pixies/core`** — Shared kernel: config, agent factory, SSE event types, OSM clients, tools.
- **`@pixies/server`** — Bun HTTP server: conversation API, SSE streaming, static web serving.
- **`@pixies/web`** — React SPA: the primary chat interface.
Verify every changed file respects package boundaries. Core should not depend on server or web. Server should not depend on web. Web should not depend on server internals.

Read `docs/CONVENTIONS.md` and `docs/adr/` for architectural decisions and naming conventions.

Any violation of package boundaries is **blocking**. No exceptions.

### 2. DRY

Read every changed file and look for:

- Logic duplicated within a file that should be a local helper
- Logic that already exists elsewhere being reimplemented instead of reused
- Copy-paste with minor variations that should be parameterized

DRY violations are **blocking**. Extract the shared logic.

### 3. Test coverage

**This is the check that most often gets hand-waved. Do not let it slide.** Insufficient test coverage is always **blocking**.

For every changed behavior, verify tests exist for:

- Happy path
- Empty / zero / nil / null / undefined inputs
- Boundary values
- Error cases

If tests are missing, enumerate exactly what's needed:

```
MISSING TESTS:
1. <file>: empty input case
2. <file>: error case — <description>
```

Do not say "we could add more tests but merge it". Write the tests or block.

### 4. Bugs

Logic errors, missing guards, unreachable paths, broken error handling, edge cases that crash or produce wrong results. **Blocking.**

## Before flagging

- Only review **changed code**, not pre-existing code
- Be certain — investigate before calling something a bug
- Don't invent hypothetical problems — explain the realistic scenario
- If unsure, say "I'm not sure about X" rather than flagging confidently

## Incidental findings

Pre-existing bugs or unrelated issues noticed during review → create a GitHub issue (`gh issue create`), check for duplicates first (`gh issue list --search ...`). Keep review output focused on changes under review.

## Output

### Ready to merge

```
VERDICT: ready to merge
```

### Needs fixes

```
VERDICT: needs fixes

BLOCKING ISSUES:
1. [architecture] file:line — description of the violation
2. [dry] file:line — description of the duplication
3. [tests] missing coverage for X, Y, Z
```

Every issue gets the tag and the specific location. Fix these and re-request review.

## General output rules

- Direct and clear about why something is wrong
- Every issue is blocking or non-blocking — never "suggested" or "nice to have"
- Include file, line, and the realistic scenario that triggers it
- No flattery, no filler, no hedging
