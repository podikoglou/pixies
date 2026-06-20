---
name: write-adr
description: Record architecturally-significant decisions as ADRs (Architecture Decision Records) in the pixies house style. Proactively trigger whenever a decision with long-term, hard-to-reverse, or cross-cutting consequences is made or just settled — choosing between approaches, picking a library/framework, setting a package boundary, data/wire contract, ownership or invariant rule, or error-handling strategy. Don't wait to be asked; when such a decision is reached in conversation or code, propose recording it as an ADR. Also use when a new decision overturns or refines a prior ADR (supersession/revision), or when deciding whether something warrants an ADR vs a GitHub issue vs a CONVENTIONS rule.
---

# write-adr

## File
`docs/adr/NNNN-kebab-name.md` (next number via `ls docs/adr/`). `Status: Proposed` → `Accepted — YYYY-MM-DD` → `Superseded by ADR-NNNN — YYYY-MM-DD`.

## Template
```
# ADR-NNNN: <title>
**Status:** Accepted — YYYY-MM-DD
## Context      — situation/problem (not the solution)
## Decision     — the choice, one short paragraph
## Rationale    — why; include the deletion test ("if I delete X, what breaks?")
## Consequences — Positive / Negative (both required)
## Durability   — what must stay true; when to revisit
## Alternatives considered — each alternative + why rejected (exhaustive)
## References   — related ADRs, #issues, commits, file:line
```

## Rules
- **Supersede** overturns (new ADR; mark old `Superseded by ADR-NNNN`). **Revise in place** (add `## Revision — date`, keep original) only for narrow refinements. Never silently rewrite accepted text.
- Both-sign Consequences, exhaustive Alternatives, cross-references — all required.

Worked examples: `docs/adr/0001`–`0005`.
