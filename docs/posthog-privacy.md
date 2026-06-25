# PostHog privacy baseline

Developer-facing note on Pixies' analytics posture: what we collect, when, and the rules future changes must follow. This is not the end-user privacy policy (separate document) and not a PostHog manual — for PostHog's own behaviour, see [their docs](https://posthog.com/docs).

## Posture

Analytics are **off by default**. The SPA loads the PostHog client only when `VITE_POSTHOG_KEY` is set; with it unset, no PostHog code runs and nothing leaves the browser. Opt-in is a deployment decision, not an end-user one.

## Architecture

- **Public/secret key separation.** The web SPA uses `VITE_POSTHOG_KEY` — PostHog's public project token, safe to bundle, write-only. Server-side capture (when it ships) uses `POSTHOG_API_KEY`, the secret. The secret never reaches the browser; the web package must never reference it.
- **Anonymous only.** Pixies has no authentication, so we never call `posthog.identify()`. PostHog assigns a random `distinct_id` per browser; nothing ties events to a person.
- **Client-gated, not idle.** The provider is mounted conditionally on the env key. There is no "loaded but sending nothing" state — it's all or nothing.

## Current state

Every capture surface is disabled (`packages/web/src/contexts/posthog-provider.tsx`):

- `autocapture: false`
- `capture_exceptions: false`
- `disable_session_recording: true`

The only traffic the integration produces today is PostHog's decide/handshake request and the anonymous `distinct_id` in `localStorage`. When opted in, PostHog Cloud also sees the client IP by default; controlling that is a PostHog project setting. No query text, DOM content, or input values are sent.

**Contract for future work:** any change that turns a surface on, or adds a `capture` call, must update this document and must never send query strings — those carry sensitive location data.

## Limitations / roadmap

- **No reverse proxy.** The SPA posts direct to PostHog Cloud, so ad blockers may silently drop telemetry. Proxying `/ingest` through the Pixies server is a future option.
- **No consent UI.** Pixies ships no cookie/consent banner. Operators in jurisdictions that require consent (e.g. EU) must gate the env key behind their own consent flow.
