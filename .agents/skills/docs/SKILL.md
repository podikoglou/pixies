---
name: docs
description: Write or edit technical documentation under docs/ (and README, AGENTS.md prose). Use when creating, revising, or reviewing evergreen docs — reference, conventions, or guides.
---

# Write / edit docs

Load the **`writing`** skill first. It carries the format rules, the banned-voice table, the detail-calibration rule, and the mandatory self-audit. This file adds only what's specific to evergreen docs.

## What a doc is

Written for a zero-context reader who arrives in a year with no memory of why it exists. It describes the **current state** of the system — never a change, never a reply to a conversation.

## Doc-specific rules (on top of `writing`)

- **Current state only.** No "removed", "migrated", "formerly", "now uses", "as of #N". History is git + ADRs. If a heading reads like a changelog entry, it's wrong.
- **Describe behavior and contracts, not implementation.** Name a file path only when a reader must *locate* it and the path is the stable interface (e.g. a config-key location, a sink they must edit). Never a function name, line number, issue #, PR #, or commit.
- **Right shape per doc type:**

  | Type | Model in this repo | Shape |
  |---|---|---|
  | reference (API, config) | `docs/api/sse.md` | tables, diagrams, terse prose |
  | convention | `docs/CONVENTIONS.md` | short rules; tables for enumerations |
  | concept / guide | — | thesis-first prose + tables |

- **Thesis-first sections.** Each heading answers one question a reader would bring; the first sentence states the answer.
- **Cut relentlessly.** Ten lines that answer the question beat fifty that don't.

## Exemptions

- **ADRs** record decisions and history by design — they're exempt from the no-changelog rule and have their own skill (`write-adr`) and template. Don't apply this skill to ADRs.

## Doc-specific self-audit (in addition to `writing`)

- [ ] No changelog / update voice anywhere
- [ ] No issue #, PR #, commit hash, or line number
- [ ] Every file path named is one a reader must locate (a stable interface), not an implementation detail
- [ ] Each section's first sentence states its answer
