# PostHog privacy baseline

This document is the operator-facing privacy baseline for the PostHog web
integration. It is established by the foundation work (#170) and inherited by
the downstream issues that turn individual features on:

- #172 — client-side error monitoring
- #173 — product analytics (events & dashboards)
- #175 — session replay

Each of those issues **must** update this document when it changes what leaves
the browser.

## Off by default

PostHog is **off by default**. The SPA only initialises the PostHog client when
the operator sets `VITE_POSTHOG_KEY` in the environment. With the key unset, the
`PostHogProvider` is never mounted, no PostHog script runs, and **zero**
telemetry leaves the browser. There is no client-side "send nothing but still
load" mode — it is all or nothing.

Opt-in is therefore an operator deployment decision, not an end-user decision
(see [Consent & opt-out](#consent--opt-out) for the end-user story).

## Keys: public token vs secret key

Pixies uses **two distinct** PostHog credentials. Do not confuse them:

| Variable | Where | Exposure | Purpose |
| --- | --- | --- | --- |
| `VITE_POSTHOG_KEY` | web SPA (Vite) | **Public** — shipped to the browser | Client-side capture (this integration) |
| `POSTHOG_API_KEY` | server (`@pixies/server`) | **Secret** — never reaches the browser | Server-side capture (separate work, #171-family) |

`VITE_POSTHOG_KEY` is PostHog's *public project token*. It is safe to ship to
the browser — it can only write events to your project, not read them. Anyone
who loads the SPA can read it from the bundle; that is by design.

The secret server key must never be referenced from the web package.

## What is collected today (foundation)

With the foundation only (#170), the client is initialised but **every capture
surface is disabled**:

- `autocapture: false` — no automatic DOM/click capture.
- `capture_exceptions: false` — no automatic error capture.
- `disable_session_recording: true` — no session replay.

Even with everything off, initialising the client sends a minimal handshake to
PostHog (the decide/config request) and stores an anonymous `distinct_id` in
`localStorage`. This is the only traffic the foundation generates.

## Identity

Pixies has **no authentication**. PostHog is therefore used in anonymous mode:

- PostHog generates a random `distinct_id`, persisted in `localStorage`.
- We never call `posthog.identify()`.
- No name, email, account, or conversation content is attached to a person
  profile.

The `distinct_id` is a per-browser random string. It is **not** the conversation
UUID and it is **not** correlated with the server-side conversation ID in this
integration. (Cross-correlating browser and server events is a future decision;
see [Open questions](#open-questions).)

## PII and sensitive content

Pixies queries are natural-language questions about places. They may contain
personal or sensitive location data (" clinics near my home at …", "where I
live"). Because the foundation ships with autocapture and replay off, **no query
text, no DOM content, and no input values are sent to PostHog**.

When #173 (product analytics) turns on explicit event capture, each `capture`
call must send only non-sensitive metadata (event name + counts), never the
query string. When #175 (session replay) turns on recording, it must configure
text/input masking as part of that issue.

## Cookies & persistence

PostHog persists its anonymous `distinct_id` in `localStorage` by default (not a
cookie). Pixies does not change this default. No consent cookie is set by Pixies
itself.

## Consent & opt-out

Because PostHog is off unless the operator opts in, end-user consent is the
operator's responsibility to wire (cookie banner, preference centre, etc.) if
their deployment jurisdiction requires it (e.g. GDPR/ePrivacy in the EU). The
integration exposes the standard PostHog opt-out API:

```ts
posthog.opt_out_capturing()   // user opts out
posthog.has_opted_out_capturing()
posthog.opt_in_capturing()    // user opts back in
```

Operators in the EU should gate `VITE_POSTHOG_KEY` behind a consent decision
before mounting the provider. Pixies does not ship a consent UI.

## IP collection

PostHog Cloud ingests the client IP by default on ingest. To stop IP storage,
disable "Save incoming IP address" in your PostHog project settings
(Project → Settings → Data governance). This is a project-level setting, not
something the SPA can control.

## Reverse proxy

The foundation talks **directly** to PostHog Cloud (`api_host` = the configured
Cloud host). This means ad blockers may silently drop telemetry. A reverse
proxy through the Pixies server (`/ingest` → PostHog Cloud, as recommended by
PostHog to dodge ad blockers) is **not** part of the foundation and is tracked
as a follow-up; it would require a new server route and a Caddy/production
proxy rule.

## Open questions

These are intentionally unresolved by the foundation and should be settled by
the issue that needs them:

1. **Browser↔server correlation.** Should the SPA send the conversation UUID to
   PostHog (as an event property or via `X-POSTHOG-DISTINCT-ID` to the server)
   so product analytics can be joined with server-side logs? This turns the
   conversation UUID into a tracking key with retention implications.
2. **End-user consent UI.** Does Pixies ship a consent banner, or is that
   purely an operator concern?
3. **Data residency.** EU vs US Cloud region is per-deployment (`VITE_POSTHOG_HOST`);
   document the default for the reference deployment.
