# PostHog privacy baseline

## Enabling

Off by default. Set `VITE_POSTHOG_KEY` and the SPA initialises the PostHog client; unset means no PostHog code runs. `VITE_POSTHOG_HOST` optionally selects the Cloud region (e.g. `https://eu.i.posthog.com`).

## Keys

| Variable | Package | Exposure |
|---|---|---|
| `VITE_POSTHOG_KEY` | web | Public project token — safe to bundle, write-only |
| `POSTHOG_API_KEY` | server | Secret — must never reach the browser |

## What is collected

The client mounts with every capture surface disabled (`packages/web/src/contexts/posthog-provider.tsx`):

- `autocapture: false`
- `capture_exceptions: false`
- `disable_session_recording: true`

The only traffic is PostHog's decide/handshake request and an anonymous `distinct_id` in `localStorage`. PostHog Cloud receives the client IP on ingest by default. No query text, DOM content, or input values are sent.

Events are anonymous: Pixies has no authentication, so `posthog.identify()` is never called and PostHog assigns a random per-browser `distinct_id`.

## Known gaps

- No reverse proxy: the SPA posts direct to PostHog Cloud, so ad blockers may silently drop events. A `/ingest` proxy through the pixies server is a future option.
- No consent UI: operators in jurisdictions that require consent must gate `VITE_POSTHOG_KEY` behind their own consent flow.

## Changing this

Any change that enables a capture surface or adds a `capture` call must update this document, and must never capture query strings — they may contain sensitive location data.
