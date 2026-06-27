# ADR-0012: Allowlist PostHog Logs egress

**Status:** Accepted — 2026-06-27

## Context

ADR-0009 shipped `info`+ server logs to PostHog Logs via the `@logtape/otel` OTLP/HTTP sink, with a denylist redacting `DEFAULT_REDACT_KEYS = ["url", "query"]` at egress. That denylist was the only gate between server log records and PostHog Cloud: every property not on it shipped verbatim.

A denylist can only ever cover fields someone remembers to add. Several `info`+ fields were shipping unredacted precisely because they were not on it:

- `err` on error/fatal records — `.message` embeds raw OSM HTTP bodies (#221).
- `ip` on `rate limit denied` warnings — raw client IP (#222).
- `cause` on "invalid response shape" warnings — may reference place-bearing response data (#220).
- `remark` on `overpass remark` warnings — OSM runtime error text (minor; third-party, not user PII).

Each leak traced to the same root cause: shipped by default because not explicitly blocked.

## Decision

Invert the sink. Ship only an allowlist of known-safe property keys (`DEFAULT_ALLOW_KEYS`); replace every other property with `"[redacted]"` before egress. Console/stdout keeps full detail. Scrub unknown keys rather than dropping them, to preserve the signal that a field was present.

## Rationale

**Deletion test.** Delete the allowlist and return to the denylist, and what we lose is privacy by construction: every future log field is again a potential leak pending someone remembering to add it to the denylist. The allowlist makes the safe state the default.

**Asymmetric failure modes.** Under a denylist, forgetting a field leaks it — silent, and once in PostHog Cloud, irreversible. Under an allowlist, forgetting a field scrubs it — loud (visible as `[redacted]`) and recoverable (missing telemetry, not exposed data). The allowlist's failure mode is the cheap one. The only way to leak under an allowlist is to add a sensitive key *to* it, an explicit act rather than an omission.

**Scrub, not drop.** Scrubbing to `"[redacted]"` keeps the signal that a field existed, which helps diagnose missing-telemetry bugs, and matches the prior `url`/`query` behaviour.

## Consequences

**Positive:**

- Privacy by construction: a future `logger.error(..., { err })` or `{ request }` cannot leak by default.
- One fix closes #220, #221, and #222 instead of a per-field redaction per leak.
- The allowlist is exhaustive over the property keys of every current `info`+ log site, so no current telemetry is lost. `debug`-only keys (e.g. queue instrumentation) are deliberately excluded — those records never reach the sink.

**Negative:**

- The allowlist is a convention obligation, not type-enforced: a new safe field must be added to `DEFAULT_ALLOW_KEYS` or it ships as `[redacted]` (lost telemetry, not a leak).
- Redaction is keyed by property name, so two distinct usages of the same key cannot be distinguished. `url` is both the Nominatim request URL (query-bearing) and the server listen address; the allowlist scrubs both. Acceptable — the listen address is not telemetry-critical.

## Durability

Holds while PostHog Logs is an off-instance egress path for server logs and the posture is "ship nothing sensitive by default." Revisit if the sink moves to a trusted first-party destination where full detail is acceptable, or if structured logging gains a type-level redaction mechanism that makes an allowlist redundant.

## Alternatives considered

- **Keep the denylist; add the leaked fields to it.** Rejected — treats symptoms, not the root cause; the next forgotten field leaks again, and each of #220/#221/#222 becomes a separate one-line fix and a separate future leak.
- **Drop unknown keys outright instead of scrubbing to `[redacted]`.** Rejected — loses the signal that a field existed, making missing-telemetry bugs harder to spot.
- **Type-level redaction (branded property keys / a schema over log properties).** Rejected — LogTape's `properties` is a `Record<string, unknown>`; enforcing a typed surface across every call site is disproportionate to the risk, and the allowlist already makes the default safe.

## References

- ADR-0009 — the LogTape/OTel egress sink this refines.
- #223, #220, #221, #222.
- `packages/core/src/logging/posthog-logs-sink.ts`, `docs/posthog-privacy.md`.
