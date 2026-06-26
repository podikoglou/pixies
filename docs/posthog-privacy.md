# PostHog privacy baseline

## Enabling

Off by default. Set `VITE_POSTHOG_KEY` and the SPA initialises the PostHog client; unset means no PostHog code runs. `VITE_POSTHOG_HOST` optionally selects the Cloud region (e.g. `https://eu.i.posthog.com`).

## Keys

| Variable | Consumer | Exposure |
|---|---|---|
| `VITE_POSTHOG_KEY` | web | Public project token — safe to bundle, write-only |
| `PIXIES_POSTHOG_API_KEY` | server | Secret — must never reach the browser |

## What is collected

The client mounts with these capture surfaces (`packages/web/src/contexts/posthog-provider.tsx`):

- `autocapture: false` — no automatic element/click/input capture, so the composer's query text is never collected. Product events are sent explicitly instead (see below).
- `capture_exceptions: true` — unhandled errors (`window.onerror`), unhandled promise rejections, and React render crashes (caught by the error boundary in `packages/web/src/components/error-boundary.tsx`) are sent to PostHog Error Tracking. Each carries its JS stack trace; React crashes additionally carry the component stack.
- `disable_session_recording: true` — no DOM recording.

Beyond PostHog's decide/handshake request and an anonymous `distinct_id` in `localStorage`, the events sent are the exception events above (only when one occurs) plus the explicit product events below. PostHog Cloud receives the client IP on ingest by default. Stack traces and component stacks carry code paths (file names, line/column, component names) — never query text, DOM content, or input values.

Events are anonymous: Pixies has no authentication, so `posthog.identify()` is never called and PostHog assigns a random per-browser `distinct_id`.

### Product analytics events

A small set of explicit events are fired at specific user-action sites (`packages/web/src/lib/posthog-capture.ts`), each carrying only coarse metadata:

| Event | Fires when | Properties |
|---|---|---|
| `message_sent` | a query is sent | `is_new_conversation` (bool) — opening vs follow-up message |
| `map_opened` | a map result renders with markers | `marker_count` (int) — number of pins shown |
| `tool_error` | a tool call fails | `tool_name` (string) — the internal tool id, e.g. `query_osm` |
| `user_stop` | the user clicks Stop mid-stream | `had_output` (bool — whether any tool activity had rendered before the stop) |
| `tool_empty` | a data-fetch tool call succeeds (`query_osm`, `geocode`, `reverse_geocode`) | `tool_name` (string), `result_count` (int — feature count returned; `0` is the empty / zero-result outcome) |

None carry the query text, place names, coordinates, or error messages — only booleans, counts, and our own tool identifiers. They answer coarse product questions (engagement, success rate, where users get stuck) without touching the potentially sensitive location data in the prompt.

## Known gaps

- No reverse proxy: the SPA posts direct to PostHog Cloud, so ad blockers may silently drop events. A `/ingest` proxy through the pixies server is a future option.
- No consent UI: operators in jurisdictions that require consent must gate `VITE_POSTHOG_KEY` behind their own consent flow.

## Server logs (PostHog Logs)

Off by default; enabled by setting `PIXIES_POSTHOG_API_KEY` (the server secret — must never reach the browser; it is distinct from the `VITE_POSTHOG_KEY` browser token). `PIXIES_POSTHOG_HOST` selects the PostHog Cloud region (default `https://eu.i.posthog.com`). Both are parsed through the TypeBox config schema, so a malformed host is rejected at boot.

When enabled, `info`+ server log records are shipped to PostHog Logs over OTLP/HTTP (`<host>/i/v1/logs`). `debug`-level records are dropped at the logger threshold and never leave the instance.

**Redaction at egress:** the `url` and `query` properties are replaced with `"[redacted]"` before egress, because Nominatim request URLs encode the `q=<place>` query parameter (sensitive location data). Local stdout retains full detail — redaction applies only on the off-instance egress path. This is defense-in-depth: today's location-bearing fields are `debug` (already dropped), but the redaction protects against an operator raising the level to `debug` and against future info+ fields.

Records DO carry: the message string, category, level, timestamp, and other structured properties (counts, durations, service names, conversation ids, error tags). They never carry the query text or place names — those live only in the `url`/`query` fields, which are redacted.

## Alerting

Configured in the PostHog dashboard, not in the app. Fires only on records already ingested — server logs (above) and client exceptions (Error Tracking). It sends no additional data; notifications are derived from what's already collected, so alerting adds no privacy surface.

## Server analytics (PostHog events)

Distinct from the PostHog **Logs** path above: this covers product **events** (not log records) captured by the server via `packages/server/src/posthog.ts`. Off by default; enabled by the same `PIXIES_POSTHOG_API_KEY` server secret (no key → no client → no captures and no network). `PIXIES_POSTHOG_HOST` selects the Cloud region (default `https://eu.i.posthog.com`). Both are parsed through the TypeBox config schema; the server never reads `process.env` directly.

Every captured event sets `$process_person_profile: false`. Pixies is anonymous (no auth), so PostHog must never materialise a Person profile per conversation/IP — without this flag, every conversation or client IP would create an orphan Person.

Events carry only coarse metadata — counts, ids, tags — never message, query, or place text:

| Event | Fires when | distinctId | Properties |
|---|---|---|---|
| `conversation started` | `POST /conversations` succeeds | conversation UUID | `message_length` (char count of the first message — never content) |
| `message sent` | `POST /conversations/:id/messages` succeeds | conversation UUID | `message_length` (char count — never content) |
| `conversation deleted` | `DELETE /conversations/:id` succeeds | conversation UUID | — |
| `rate limit exceeded` | a POST is denied by the IP limiter | client IP | `path` (route template, e.g. `/conversations`) |
| `conversation budget exceeded` | a prompt is rejected with `BudgetExceeded` | conversation UUID | `tokens_used`, `token_budget` (token counts) |
| `agent stream error` | the SSE agent stream throws mid-flight | conversation UUID | `error_tag` (the `_tag` discriminant only — see below) |
| `agent stream disconnect` | the SSE stream is cancelled before it writes `done`/`error` (client went away — Stop click or tab close/network drop) | conversation UUID | `elapsed_ms` (ms since stream start), `had_output` (bool — whether a tool-execution event was emitted) |
| `agent stream first token` | the agent emits its first user-facing text token (mid-stream) | conversation UUID | `ttft_ms` (int — ms from stream start to first text token) |
| `agent stream done` | the agent stream completes normally (terminal `done` frame, not aborted) | conversation UUID | `duration_ms` (int — ms from stream start to `done`), `ttft_ms` (int, optional — present iff a first token was emitted) |

For `agent stream error`, **only the error `_tag` is captured — never `err.message`, the `Error` object, or a stack trace.** Overpass/Nominatim errors embed OSM HTTP response bodies and the searched place name in `.message`, so shipping the message would leak location data. The capture site carries an inline comment noting this is a privacy choice, subject to change if a sanitised message is ever introduced.

`agent stream disconnect` is the survivor-bias correction for latency work: latency measured only on streams that reach `done` ignores the ones users gave up on, so this event records the streams that never complete. The server cannot distinguish a user Stop from a passive disconnect (both cancel the stream), so it fires for both — the client `user_stop` event is the active-rejection subset, on a deliberately-unlinked distinctId (see above). Assistant text is suppressed on the wire, so `had_output` reflects the first tool-execution event rather than a text token.

`agent stream first token` and `agent stream done` capture raw integer millisecond durations (not coarse buckets) so PostHog can compute native p50/p90/p99 and drive latency SLO/regression math — buckets would destroy percentiles. Durations are within the existing "coarse metadata" rule (pure numbers, no location/query/message content). `first token` fires **mid-stream** (at the first `text_delta`, read on the raw agent event before the wire suppression drops assistant text), so even streams that are later aborted still contribute a TTFT measurement — capturing TTFT only at `done` would re-create the survivor-bias this is about. `done` only fires when the stream's lifecycle state is still `running` (an abort transitions it to `aborted` in the `SseWriter` onClose lambda, so aborted streams are never miscounted as fast completions); its `ttft_ms` reuses the `first token` value rather than recomputing it.

distinctIds are deliberately **not** correlated with the browser's anonymous PostHog id: conversation events key on the conversation UUID, rate-limit events key on the client IP. No `X-POSTHOG-*` headers or `posthog.identify()` calls thread the two together.

## Changing this

Any change that enables a capture surface or adds a `capture` call must update this document, and must never capture query strings — they may contain sensitive location data. Any new server log field that could carry location data must be added to the PostHog sink's `redactKeys` (`packages/core/src/logging/posthog-logs-sink.ts`). Any new server capture event must carry only coarse metadata (counts, ids, tags) and must never include message, query, or place text.
