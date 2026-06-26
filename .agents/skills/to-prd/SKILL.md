---
name: to-prd
description: Turn a resolved plan into a PRD and publish it as a GitHub issue — the parent that implementation issues trace back to. Use after grill-me to freeze a non-trivial feature's design before coding, or when a feature will span multiple issues/PRs.
---

# Turn a plan into a PRD

Load the **`writing`** skill first for the prose rules and self-audit. This skill adds the PRD-specific process and template.

**Where it fits:** `grill-me` resolves the design → **`to-prd`** freezes it → implementation issues (optional) → `tdd-solver` builds → `review` gates.

## What a PRD is

A short doc that nails down **what** and **why** before code — never **how**. It's the cheapest place to be wrong: a hole found here costs minutes, in code it costs hours. It freezes the shared understanding from a grilling into a spec an agent can build against without guessing the gaps.

## When to write one (and when not to)

Write one when the feature is non-trivial or unknown-heavy, when it will span multiple issues/PRs (then the PRD is the parent they trace back to), or when you're handing work to an agent and want a gap-free contract.

Skip it for trivial fixes, tweaks, and exploratory spikes — grill briefly and build.

## Process

- [ ] **1. Confirm the plan is resolved.** If the design tree has open branches, run **`grill-me`** first — this skill freezes understanding, it doesn't produce it.
- [ ] **2. Ground in the current code.** Explore the repo; use the project's domain language (`docs/CONVENTIONS.md`) and respect ADRs (`docs/adr/`). If a decision needs a new ADR or contradicts one, flag it — don't silently override.
- [ ] **3. Fill the template** below.
- [ ] **4. Publish as a GitHub issue** — check for duplicates first, then create:
  ```sh
  gh issue list --search "<feature>"
  gh issue create --title "feat: <feature>" --body-file <path>
  ```
- [ ] **5. (Optional) Break into implementation issues** — vertical slices, each linking back to the PRD (`Parent: #N`). Stop here if you'll implement directly.

## Template

> ## Problem
> The pain, from the user's perspective.
>
> ## Solution
> The change, from the user's perspective.
>
> ## User stories
> A numbered list, each `As a <actor>, I want <feature>, so that <benefit>`. If you can't name the beneficiary or the benefit, it isn't a requirement.
>
> ## Implementation decisions
> Modules, interfaces, schema, API contracts — the decisions, not the code. **No file paths or code snippets** (they rot fast). Exception: a prototype-derived snippet that encodes a decision more precisely than prose (state machine, schema, type shape) — inline only the decision-rich parts and note it came from a prototype.
>
> ## Testing decisions
> What makes a good test here (external behavior, not internals), which modules are tested, and prior art (similar tests in the repo).
>
> ## Out of scope
> What you're explicitly **not** doing. Often the most useful section.
>
> ## Further notes
> Anything else.

## Rules (on top of `writing`)

- **What and why, not how.** The PRD is the destination, not the journey; implementation detail belongs in the issues.
- **No file paths or code** — they rot on the next refactor (the evergreen-doc calibration from `writing`).
- **Use the project's domain language** so the PRD and the code agree on names.

Then run `writing`'s self-audit before publishing.
