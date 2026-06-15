---
name: issue
description: Create GitHub issues for the pixies project. Use when asked to file an issue, create a bug report, or open a feature request.
---

# Create Issues

## How to create an issue

Use `gh issue create`:

```sh
gh issue create
```

Always check for duplicates first:

```sh
gh issue list --search "keyword"
```

## Issue title conventions

- Bug: `bug: <concise description>`
- Feature: `feat: <concise description>`
- Task: `task: <concise description>`
