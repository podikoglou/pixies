# ADR-0009: LogTape over Pino; ship logs to PostHog Logs via OpenTelemetry

**Status:** Accepted — 2026-06-25

## Context

The server log stream needs to reach PostHog Logs so it can be analysed alongside product/error data and drive alerting. The current logger is Pino. The choice of logger is open: keep Pino, or migrate.

Three forces shape the decision:

- **The ship mechanism is OpenTelemetry.** PostHog Logs ingests over OTLP/HTTP with project-token Bearer auth, so the whole point is an OTel log pipeline — not ad-hoc POSTs to a capture API.
- **The stream carries location PII.** Geocoding request URLs encode the searched place name, so anything that leaves the instance must be redacted at the egress boundary (local stdout stays untouched).
- **Migration is effectively free here.** This is an LLM-authored codebase, so rewriting every log statement costs minutes, not a project. The usual "switching cost favors the incumbent" weight does not apply — the decision is made on fit.

## Decision

Migrate the logger from Pino to LogTape, and ship logs to PostHog Logs via LogTape's official `@logtape/otel` sink — env-gated off by default, with location fields redacted at the egress sink.

## Rationale

**Deletion test.** If we delete LogTape and stay on Pino, what we lose is the worker-free OTel sink — the entire reason for the change. Pino's only official OTel transport is worker-based, and the codebase already avoids worker-thread transports for runtime safety. Staying on Pino therefore means hand-rolling a bespoke OTLP exporter to dodge workers — maintaining our own log shipper instead of using the supported one. The choice reduces to: *which logger makes the OTel sink first-class?* LogTape does; Pino forces it to be custom.

The rest confirms rather than decides:

- LogTape's sinks are plain async functions with no worker threads — coherent with the runtime-safety stance the codebase already holds, rather than something to work around.
- Because migration is ~0 cost, the comparison is purely architectural fit, and LogTape fits.
- LogTape adds hierarchical categories (per-module level/sink control the flat setup lacks), is zero-dependency, and is native to Bun and other runtimes.
- Redaction is available either way, so it is not a differentiator.

## Consequences

**Positive:**

- The OTel requirement is met by the supported `@logtape/otel` path — no bespoke exporter to maintain.
- No worker transports anywhere; the workaround Pino forced is gone.
- Per-category filtering and sink inheritance become available.
- Once logs reach PostHog, PostHog alerting can replace the hand-rolled Discord error transport.

**Negative:**

- LogTape is younger, with a smaller community than Pino.
- `@logtape/logtape` + `@logtape/otel` are new dependencies (net footprint likely shrinks; LogTape is zero-dependency).
- The redaction key set is a convention obligation: any new log field carrying location data must be added to it. Not type-enforced.

## Durability

Holds while Pixies runs on a LogTape-supported runtime, PostHog Logs accepts OTLP/HTTP with Bearer auth, and `@logtape/otel` remains maintained.

Revisit if LogTape stagnates, `@logtape/otel` cannot target PostHog's ingest/auth, or the OpenTelemetry JS story on Bun solidifies enough that Pino's worker transport becomes safe and Pino's broader ecosystem starts to matter.

## Alternatives considered

- **Stay on Pino + a hand-rolled OTLP sink.** Rejected — it meets the OTel requirement only through bespoke code, because Pino's official OTel transport is worker-based and already disqualified. With migration cost ~0, there is no reason to prefer the hand-rolled path over LogTape's supported sink.
- **Stay on Pino + its official OTel transport.** Rejected — it is worker-based, which reverses the runtime-safety stance and reintroduces the worker surface the codebase chose against.
- **Full OpenTelemetry SDK under Pino.** Rejected — heavier dependency surface for the same outcome; `@logtape/otel` wraps the needed plumbing with less surface area.
- **Global logger-level redaction.** Rejected — redaction must leave local stdout untouched for debugging, so it belongs at the egress sink, not in the base logger.
- **Ship via PostHog's capture API instead of OTLP.** Rejected — the requirement is OpenTelemetry; OTLP keeps the pipeline standards-based and consumable by any OTel-aware tool.
