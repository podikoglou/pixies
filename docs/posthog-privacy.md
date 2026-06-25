# PostHog privacy baseline

Off by default. The SPA loads the PostHog client only when `VITE_POSTHOG_KEY` is set; unset means no PostHog code runs.

**Keys.** Web uses `VITE_POSTHOG_KEY` (public project token — safe to bundle, write-only). Server-side capture uses `POSTHOG_API_KEY` (secret). The web package must never reference the secret.

**Identity.** Anonymous only. Pixies has no auth, so `posthog.identify()` is never called; PostHog assigns a random per-browser `distinct_id`.

**Capture surfaces** (`packages/web/src/contexts/posthog-provider.tsx`), all off:

- `autocapture: false`
- `capture_exceptions: false`
- `disable_session_recording: true`

Only traffic today is PostHog's decide/handshake request and the `distinct_id` in `localStorage`. PostHog Cloud receives the client IP on ingest by default. No query text, DOM, or input values are sent.

**Changing this.** Turning a surface on or adding a `capture` call requires updating this doc, and must never capture query strings — they carry sensitive location data.

**Gaps.** No `/ingest` proxy (SPA posts direct to Cloud; ad blockers may drop telemetry). No consent UI (EU operators must gate the key behind their own consent flow).
