---
name: writing
description: Prose-quality reference for technical writing — README, AGENTS.md, ADRs, docs, commit messages. Load directly for prose with no dedicated skill; the pr, issue, and docs skills load it themselves. Carries the format rules, banned-voice table, lifespan calibration, and mandatory self-audit.
---

# Writing base

## The principle

A prose artifact exists to let a **zero-context reader answer one specific question, fast, for the artifact's whole lifespan.** Every rule below serves that one sentence.

## Before you write — pre-flight (answer in 3 lines)

If you can't answer these, you're about to info-dump:

- **Reader** — who, with what context, reading when (now vs in 2 years)?
- **Question** — the one thing they need this artifact to answer.
- **Lifespan** — ephemeral (PR, issue) or evergreen (doc)? Sets the detail calibration below.

## Format — right shape per content

| Content | Shape |
|---|---|
| enumeration / mapping | table |
| sequence / steps | ordered list |
| criteria | checklist |
| argument, explanation, "why" | prose — the only valid use of prose |

- A bullet is **one clause**. If it needs 3+ sentences, it's a sub-section: **bold thesis line** + optional one-line detail.
- **Thesis-first** — every section and paragraph opens with the sentence the reader most needs; detail follows.
- Time budget: under a minute for a PR/issue; any single answer findable in <30s in a doc.

## Banned voices

Each fails the "zero-context reader" test. If you catch one, rewrite.

| Voice | Symptom | Fix |
|---|---|---|
| Marketing | describes what a tool/library *is* or *can do*, not what *we* do with it | delete the tool's feature copy; keep only our usage and our contracts |
| Changelog / update | "X (removed)", "formerly Y", "now Z", references to the refactor that just happened | describe current state only; history lives in git and ADRs |
| Reply-to-the-user | only makes sense as a reply to a conversation; assumes shared context the reader doesn't have | rewrite so a stranger in 2 years understands it cold |
| Info-dump / book | prose where a table/list belongs; no thesis; a brain-dump | pick the shape from the table above; lead with the thesis |
| Stale-pointer | PR/issue numbers, commit hashes, internal names that will rot | calibrate to lifespan (below) |

## Detail calibration by lifespan

The one rule the specializations override. Match pointer-stability to artifact-stability:

| Artifact | Lifespan | File paths, line numbers, issue #, ADR # |
|---|---|---|
| PR, issue | ephemeral, versioned | reference freely — they age with the artifact |
| doc (evergreen) | years | describe behavior/contracts; name a path only when the path *is* the interface a reader must locate; never an issue #, PR #, commit, or line number |

## Self-audit (mandatory — do not skip)

This is the step that separates rules-on-paper from rules-enforced. After drafting, before returning or posting: re-read your own output and pass **every** check. If one fails, rewrite — do not annotate, do not justify, rewrite.

- [ ] Every bullet is one clause (no paragraph-bullets)
- [ ] Every enumeration/mapping is a table or list, not inline prose
- [ ] Every section opens with its thesis
- [ ] No banned voice (all five)
- [ ] Detail pointers match the lifespan calibration
- [ ] Cut test — every sentence serves the reader's question; the rest is deleted
- [ ] A zero-context reader passes the time budget

## Examples — real, from this repo

**Positive models** — `docs/CONVENTIONS.md` (dense, table-for-enumeration, short rules) and `docs/api/sse.md` (reference doc done right: tables for media types / event payloads / per-tool detail shapes, a lifecycle diagram, terse prose). When in doubt, write like these.

**Negative → fixed** (each is a recurring shape, not a one-off):

- **Changelog voice in a heading.** A section heading reads `## Alerting (Discord transport removed)`. The parenthetical is git history and belongs in an ADR, not the doc. Fix: `## Alerting` — the doc shows current state only.

- **Paragraph-bullets in a PR's Decisions section.** Each bullet runs 4–5 lines and buries the choice. Fix — bold thesis first, detail one line or cut:
  > - **Full removal, not fallback.** Two parallel paths would double-fire and drift.
  > - **1:1 replacement is a log alert**, not an Error Tracking alert — the old path fired on log lines.

- **Marketing voice on a vendor doc.** A paragraph listing a vendor's autocapture / session-recording / feature-flag capabilities. Fix: delete — state what *this project* collects and how to disable it, not the vendor's feature list.

- **Stale pointers in an evergreen doc.** Naming a file path is OK when a reader must locate it (a config-key location, a sink they must edit); naming a function or a line number in the same doc is not — those rot on the next refactor. Calibrate, don't ban.
