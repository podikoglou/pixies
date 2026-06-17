---
name: issue
description: Create GitHub issues for the pixies project. Use when asked to file an issue, create a bug report, or open a feature request.
---

# Create Issues

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
