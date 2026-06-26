---
name: pr
description: Write and open pull requests for the pixies project. Use when asked to open a PR, create a pull request, draft a PR, or write the PR body/description.
---

# Open Pull Requests

Load the **`writing`** skill first for the universal prose rules and self-audit. This file adds the PR-specific mechanics and body contract.

## How to open a PR

```sh
gh pr create --base main --title "<title>" --body-file <path>   # add --draft to open as draft
```

The template lives at `.github/PULL_REQUEST_TEMPLATE.md`. Fill it in, then pass the
file with `--body-file` (GitHub applies the template automatically only in the web UI).

Before creating, check for an existing PR on the branch — if one exists, add to it rather than open a duplicate:

```sh
gh pr list --head <branch>
```

### Title conventions

Conventional-commit prefix + optional scope + trailing issue ref, matching the repo's history:

- `feat(web): <subject> (#173)`
- `refactor(core): <subject> (#152)`
- `fix: <subject> (#106)` — scope optional when the change is cross-package
- `chore:`, `docs:`, `test(server):` — other common prefixes
- Append `!` before the colon for a breaking change, e.g. `refactor(server)!: ...`

Append `(#N)` when the PR implements issue #N. The body still leads with `Closes #N` /
`Refs #N` so merging closes the issue automatically.

## Body style

Applies on top of the template. The body is for what the **diff can't show**: decisions,
rationale, and scope boundaries — not a narration of the change.

### Must include

- **Issue link at the top of Summary.** `Closes #N` (merging closes it) or `Refs #N`
  (related, not closing).
- **Summary** — a few sentences on what changed and why. A reader should grasp the shape
  of the change without opening the diff.
- **Decisions** — the non-obvious choices: alternatives considered and rejected (with
  reasons), invariants preserved, why it's shaped this way. This is the core of the body.
- **Out of scope** — what you deliberately left out and why; link follow-up issues.

### Must NOT include

- **No pasted code from the diff.** Reference a file/line if you must; don't copy it.
- **No test pass/fail, counts, or "all green".** CI shows this.
- **No commit lists or file-by-file change lists.** The diff shows this.
- **No restating the linked issue.** Link it; add only what the implementation decided.

### PR-specific writing rules (on top of `writing`)

- **Decisions are bold-thesis + optional one line.** Each decision leads with a bold
  clause stating the choice; any detail is a single line under it, never a paragraph-bullet.
- **Reference freely — PRs are ephemeral.** Files, line numbers, issue #s, and ADRs age
  with the PR, so cite them (this is the PR calibration of `writing`'s lifespan rule).
- **Omit empty sections.** An empty heading is noise — drop it. Review notes in particular
  should be deleted unless there's a real gotcha or a suggested review order.
- **Scannable in under a minute.** A reviewer parses it without scrolling-and-reading.

Then run `writing`'s self-audit before posting.

## Splitting

If a PR implements multiple issues that can ship independently, split it. One PR per
independently-mergeable concern; cross-link related work with `Refs #N`.
