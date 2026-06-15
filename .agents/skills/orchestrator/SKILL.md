---
name: orchestrator
description: Orchestrate multi-phase development work using sequential subagents. Each phase covers one or a few closely-related GitHub issues, running them through plan → implement → review → fix → merge, and looping on any new issues discovered. Use when the user provides a list of phases/issues to work through, asks to "work through these issues", or describes batch work across multiple PRs.
---

# Orchestrator

## Overview

A workflow for processing GitHub issues through sequential subagent rounds. The main context is an **orchestration layer only** — you may read issues, PRs, and GitHub comments here, but no code analysis, no implementation. All real work happens in subagents.

## Quick Start

1. User provides phases (each phase = one or a few closely-related GitHub issue numbers)
2. For each phase, spawn subagents sequentially: plan → implement → review → fix (if needed) → merge
3. Loop on any new issues created by subagents
4. Notify the user after each merge

## Workflow

### Per-Phase Checklist

Run these steps **strictly in order**. No parallel subagents within a phase.

- [ ] **1. Planning subagent**
  - Pull `main`, create branch (naming: `fix/`, `refactor/`, `feat/` as appropriate)
  - Study code and determine if issue is still valid
  - Classify issue as **AFK** (agent can complete autonomously) or **HITL** (needs human checkpoint)
  - Write handoff artifact to `/tmp/pixies-handoff-<issue>.md` with: findings, plan, AFK/HITL classification, suggested skills
  - Report technical plan + recommended implementation approach (or invalidity)

- [ ] **2. Implementation subagent**
  - Read handoff artifact from `/tmp/pixies-handoff-<issue>.md`
  - Use the methodology recommended by the planning subagent
  - If unsupported features encountered: create GitHub issue, use `--no-verify` to commit
  - Push branch, create PR targeting `main`
  - If issue was classified **HITL**: stop and notify user for checkpoint before proceeding

- [ ] **3. Review subagent**
  - Read handoff artifact from `/tmp/pixies-handoff-<issue>.md` (avoids redundant analysis)
  - Load `review` skill
  - Report findings: ready to merge or needs fixes

- [ ] **4. Fix subagent** (only if review found issues)
  - Address review findings
  - Re-run tests, commit, push

- [ ] **5. Merge** (in main context, NOT in subagent)
  - `gh pr merge <number> --merge --delete-branch`
  - `git pull` on main
  - `gh issue close <number>` for each issue in phase
  - Notify the user with PR link
  - Update todo list

### After All Phases

- Check for issues created by subagents during work
- If found: create new phases and loop (same workflow)
- If none: done

## Subagent Prompt Templates

Each subagent must receive these universal instructions:

```
## CRITICAL INSTRUCTIONS
- If you come across issues or missing features, create a GitHub issue if one
  doesn't already exist. Use git commit --no-verify to commit.
- If you discover ANY issues or missing features, create a GitHub issue immediately.
  This applies to all subagents — planning, implementation, review, and fix subagents.
  Do not suppress issues; surface them all.
```

### Planning Subagent

```
Your task is to create a branch from main and analyze issue #X.
- git checkout main && git pull
- git checkout -b <appropriate-prefix>/<name>
- Read source files, understand the issue
- Do NOT make code changes. Just study and report.
- If issue is invalid, report why.
- Classify as AFK (agent can complete autonomously) or HITL (needs human checkpoint). Prefer AFK.
- Write a handoff artifact to /tmp/pixies-handoff-<X>.md containing:
  - Issue summary and validity
  - Key findings from code analysis
  - Technical plan + implementation approach
  - AFK or HITL classification (and why)
  - Suggested skills for the implementation subagent
- Return full technical plan + recommended implementation approach.
```

### Implementation Subagent

```
Branch already exists. Read /tmp/pixies-handoff-<X>.md for context.
Implement changes for issue #X.
- Write tests first where applicable, but adapt methodology to the task.
- After all work: run bun run typecheck && bun run lint && bun run test, commit, push, create PR targeting main.
- PR title: "<type>: description (#X)"
```

### Review Subagent

```
Read /tmp/pixies-handoff-<X>.md for planning context.
Load review skill. Review PR #N.
- Checkout PR locally, review changes, run bun run typecheck && bun run lint && bun run test
- Report: ready to merge or needs fixes
```

### Fix Subagent

```
Branch has PR #N open. Review found these issues: <issues>.
- Fix them, run bun run typecheck && bun run lint && bun run test, commit --no-verify, push.
```

## Rules

- **Main context is orchestration only** — you may read issues, PRs, and GitHub comments, but no code analysis
- **No parallel subagents** — sequential within a phase
- **Must pull main** before creating each new branch (previous PR may have just been merged)
- **Always spawn all subagents** — even if planning seems trivial
- **Handoff artifacts** — planning subagent writes `/tmp/pixies-handoff-<issue>.md`; implementation and review subagents read it instead of re-discovering context
- **AFK vs HITL** — planning classifies each issue; HITL issues pause after implementation for human checkpoint before review
- **Merge in main context** — never in a subagent
- **Conventional commit messages** — `fix:`, `feat:`, `refactor:`, `test:`
- **Close issues** after merge
- **Notify the user** after each phase with PR link

## Grouping Guidance

**Keep phases small.** One issue per phase is the default. Only group issues together when they are very closely related:

- They share the exact same code area and the fix is intertwined
- One issue is a direct prerequisite of the other
- They are two aspects of the same bug

When in doubt, keep them separate. Larger groups mean larger PRs, harder reviews, and more risk.
