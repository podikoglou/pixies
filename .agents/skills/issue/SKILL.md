---
name: issue
description: Create GitHub issues for the pixies project. Use when asked to file an issue, create a bug report, or open a feature request. Builds on the `writing` skill — load it first for format rules, banned voices, and the mandatory self-audit.
---

# Create Issues

Load the **`writing`** skill first for the universal prose rules and self-audit. This file adds the issue-specific mechanics and body contract.

## How to create an issue

Always check for duplicates first:

```sh
gh issue list --search "keyword"
```

### 1. Find the right template

List available templates in `.github/ISSUE_TEMPLATE/`:

```sh
ls .github/ISSUE_TEMPLATE/
```

Match the issue type to the closest template:

- Bug → `bug_report.md` or `bug.yml`
- Feature → `feature_request.md` or `feature.yml`
- Task / meta → `task.md` or any generic template

### 2. Create the issue with the template

```sh
gh issue create --template <template-name>
```

Where `<template-name>` is the filename **without** the `.md` or `.yml` extension.

If no template matches (e.g. the directory is empty or missing), fall back to a plain `gh issue create`.

### 3. Issue title conventions

- Bug: `bug: <concise description>`
- Feature: `feat: <concise description>`
- Task: `task: <concise description>`

## Body style

Applies on top of whichever template you picked.

- **The problem and why-it-matters are the core.** Any approach or solution sketch is high-level shape with trade-offs noted, not a directive or step-by-step guide.
- **Leave decisions open.** If something is unresolved (library A vs B, approach X vs Y), name it as a decision to make, not a foregone conclusion.

### Issue-specific writing rules (on top of `writing`)

- **Reference freely — issues are ephemeral.** Files, line numbers, and existing conventions
  cite the real code the issue is filed against (this is the issue calibration of `writing`'s
  lifespan rule).

Then run `writing`'s self-audit before posting.

## Splitting

If a request spans concerns that can ship or be decided independently, open a separate issue per concern and link them with `Depends on: #N`.
