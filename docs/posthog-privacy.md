# PostHog privacy baseline

PostHog ships **off by default**. Set `VITE_POSTHOG_KEY` to enable; leave it unset and no PostHog code loads.

## Keys

| Variable | Where | Exposure |
| --- | --- | --- |
| `VITE_POSTHOG_KEY` | web SPA | **Public** project token — safe to bundle |
| `POSTHOG_API_KEY` | server | **Secret** — never reaches the browser |

`VITE_POSTHOG_KEY` can only *write* events, never read them. Keep the secret server key out of the web package.

## What this integration sends

The client initialises but every capture surface is off:

- `autocapture: false`
- `capture_exceptions: false`
- `disable_session_recording: true`

The only traffic is PostHog's decide/handshake request and an anonymous `distinct_id` stored in `localStorage`. Events stay anonymous — Pixies has no auth, so `posthog.identify()` is never called. No query text, DOM content, or input values leave the browser while these stay off.

When product analytics or session replay are later enabled, this section must be updated, and query strings must never be captured — they carry sensitive location data.

## Controls

- **Disable IP storage:** PostHog Cloud → Project settings → Data governance → "Save incoming IP address" (project-level; the SPA can't toggle it).
- **End-user opt-out:** `posthog.opt_out_capturing()` / `opt_in_capturing()`. EU deployments should gate `VITE_POSTHOG_KEY` behind a consent decision; Pixies ships no consent UI.
- **Ad blockers:** the SPA talks direct to PostHog Cloud, so ad blockers may drop telemetry. A `/ingest` reverse proxy through the server is a follow-up.
