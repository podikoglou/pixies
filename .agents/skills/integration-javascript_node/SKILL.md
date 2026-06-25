---
name: integration-javascript_node
description: PostHog integration for server-side Node.js applications using posthog-node
metadata:
  author: PostHog
  version: 1.23.9
---

# PostHog integration for JavaScript Node

This skill helps you add PostHog analytics to JavaScript Node applications.

## Reference files

- `references/node.md` - Node.js - docs
- `references/posthog-node.md` - PostHog Node.js SDK
- `references/identify-users.md` - Identify users - docs

## Key principles

- **Environment variables**: Always use environment variables for PostHog keys. Never hardcode them.
- **Minimal changes**: Add PostHog code alongside existing integrations. Don't replace or restructure existing code.

## Framework guidelines

- posthog-node is the Node.js server-side SDK package name – do NOT use posthog-js on the server
- Include enableExceptionAutocapture: true in the PostHog constructor options
- Add posthog.capture() calls in route handlers for meaningful user actions – every route that creates, updates, or deletes data should track an event with contextual properties
- Add posthog.captureException(err, distinctId) in the application's error handler (e.g., Express error middleware, Fastify setErrorHandler, Koa app.on('error'))
- In long-running servers, the SDK batches events automatically – do NOT set flushAt or flushInterval unless you have a specific reason to
- For short-lived processes (scripts, CLIs, serverless), set flushAt to 1 and flushInterval to 0 to send events immediately
- Reverse proxy is NOT needed for server-side Node.js – only client-side JavaScript needs a proxy to avoid ad blockers
- Remember that source code is available in the node_modules directory
- Check package.json for type checking or build scripts to validate changes

## Identifying users

Identify users during login and signup events. Refer to `references/identify-users.md` for the identify pattern. If both frontend and backend code exist, pass the client-side session and distinct ID using `X-POSTHOG-DISTINCT-ID` and `X-POSTHOG-SESSION-ID` headers to maintain correlation.

## Error tracking

Add PostHog error tracking to relevant files, particularly around critical user flows and API boundaries.
