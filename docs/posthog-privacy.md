# PostHog privacy baseline

## Enabling

Off by default. Set `VITE_POSTHOG_KEY` and the SPA initialises the PostHog client; unset means no PostHog code runs. `VITE_POSTHOG_HOST` optionally selects the Cloud region (e.g. `https://eu.i.posthog.com`).

## Keys

| Variable | Package | Exposure |
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

None carry the query text, place names, coordinates, or error messages — only booleans, counts, and our own tool identifiers. They answer coarse product questions (engagement, success rate, where users get stuck) without touching the potentially sensitive location data in the prompt.

## Known gaps

- No reverse proxy: the SPA posts direct to PostHog Cloud, so ad blockers may silently drop events. A `/ingest` proxy through the pixies server is a future option.
- No consent UI: operators in jurisdictions that require consent must gate `VITE_POSTHOG_KEY` behind their own consent flow.

## Server logs (PostHog Logs)

Off by default; enabled by setting `PIXIES_POSTHOG_API_KEY` (the server secret — must never reach the browser; it is distinct from the `VITE_POSTHOG_KEY` browser token). `PIXIES_POSTHOG_HOST` selects the PostHog Cloud region (default `https://eu.i.posthog.com`). Both are parsed through the TypeBox config schema, so a malformed host is rejected at boot.

When enabled, `info`+ server log records are shipped to PostHog Logs over OTLP/HTTP (`<host>/i/v1/logs`). `debug`-level records are dropped at the logger threshold and never leave the instance.

**Redaction at egress:** the `url` and `query` properties are replaced with `"[redacted]"` before egress, because Nominatim request URLs encode the `q=<place>` query parameter (sensitive location data). Local stdout retains full detail — redaction applies only on the off-instance egress path. This is defense-in-depth: today's location-bearing fields are `debug` (already dropped), but the redaction protects against an operator raising the level to `debug` and against future info+ fields.

Records DO carry: the message string, category, level, timestamp, and other structured properties (counts, durations, service names, conversation ids, error tags). They never carry the query text or place names — those live only in the `url`/`query` fields, which are redacted.

## Changing this

Any change that enables a capture surface or adds a `capture` call must update this document, and must never capture query strings — they may contain sensitive location data. Any new server log field that could carry location data must be added to the PostHog sink's `redactKeys` (`packages/core/src/logging/posthog-logs-sink.ts`).
