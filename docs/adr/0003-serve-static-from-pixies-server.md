# ADR-0003: Serve static web build from the pixies server

**Status:** Accepted — 2026-06-15

## Context

The web client (`@pixies/web`) is a Vite-built SPA that produces static assets (HTML, JS, CSS). These need to be served alongside the existing SSE API server (`packages/server`). Options:

**A. Serve from the pixies server.** The existing Bun server mounts a static file route for the built web assets. Single container, single port.

**B. Separate nginx container.** A dedicated nginx container serves static assets and reverse-proxies API requests to the pixies server. Two containers in docker-compose.

**C. Separate nginx in the same container.** nginx and the Bun server run in the same container under supervisord. Single image, two processes.

## Decision

We choose **A: serve from the pixies server.**

The Bun server adds a catch-all route (`app.get('*', serveStatic('packages/web/dist'))`) that serves the built web assets. The Vite dev server proxies API requests to the Bun server during development.

## Rationale

1. **Single deployment unit.** One container, one port, one process. No docker-compose orchestration, no supervisord, no process manager. The server already runs on the target VPS — this adds zero infrastructure.

2. **No CORS configuration needed.** Same-origin serving means the web client and API share a protocol + host + port. The CORS open question in `docs/api/sse.md:295` becomes irrelevant for same-origin deployments.

3. **Adequate for single-user VPS.** nginx excels at high-concurrency static file serving, caching, TLS termination, and load balancing. None of these are bottlenecks for a single-user deployment serving ~3 static files. The Bun server's `serveStatic()` is sufficient.

4. **Vite dev proxy is the standard pattern.** During development, Vite proxies `/conversations` and `/health` to `localhost:3000`. The web code uses relative URLs (`fetch('/conversations')`), which work identically in dev (via Vite proxy) and prod (via same-origin serving). No origin management.

## Consequences

**Positive:**

- Zero new infrastructure. One `bun install && bun run build` produces a deployable artifact.
- No CORS configuration for same-origin deployments.
- Relative URLs in the web code — no environment-dependent origin logic.

**Negative:**

- The Bun server handles static file I/O alongside API requests. For a single-user deployment this is negligible; for high-traffic multi-tenant deployments, a reverse proxy in front would be appropriate. This is not a current concern.

- Static assets are served from the same process as the API. A surge in static file requests could theoretically affect API latency. Not a concern for single-user; mitigated by a reverse proxy if it ever becomes one.

## Alternatives considered

**Separate nginx container (rejected).** Adds a second container to docker-compose, a second port to manage, and CORS or reverse-proxy configuration. Justified for production multi-tenant deployments; overkill for a single-user VPS.

**Separate nginx in the same container (rejected).** Two processes (Bun + nginx) managed by supervisord. More moving parts, harder to debug, no clear benefit over a single process.

**Vite preview server (rejected).** `vite preview` serves the built output but is not production-hardened. Running it alongside the Bun server means two HTTP servers on different ports, requiring a reverse proxy to unify them — adding complexity for no gain.
