# ADR-0001: Interface-independent core, not SSE-fitted

**Status:** Accepted — 2026-06-14

## Context

Pixies is moving from a single TUI binary to a multi-tenant product. The primary client surface will be web/mobile over HTTP/SSE; the TUI becomes a secondary adapter.

Two architectures were considered:

**A. Interface-independent core.** A `core` package that knows how to construct a configured `Agent` (system prompt, model, tools, OSM clients), but does not own conversations or runtime concerns. Each adapter (`server`, `tui`) imports the core, creates its own `Agent` instances, and owns its runtime (process model, transport, lifecycle).

**B. SSE-fitted core.** The SSE server is the core; the TUI is a client of the SSE server over loopback HTTP. There is no separate headless interface — the SSE protocol is the contract.

## Decision

We choose **A: interface-independent core**.

The `core` package exposes a factory `createAgent(): Agent` plus the system prompt, tools, and OSM clients. The `server` and `tui` adapters each consume the factory and own their runtime concerns.

## Rationale

1. **Deletion test on the core passes.** Removing `core` would duplicate system-prompt + tool + model-resolution + OSM-client wiring across both adapters. Real value, real seam.

2. **Deletion test on a hypothetical Pixies-specific `Conversation` abstraction fails.** Wrapping `Agent` to hide pi-agent-core types is a pass-through: removing it leaves adapters using `Agent` directly with no loss. We do not introduce this wrapper.

3. **Adapters are radically different.** The TUI is single-user, in-process, persistent for the process lifetime. The server is multi-tenant, networked, ephemeral per-conversation. A shared runtime would have to abstract over both, and the abstraction would leak.

4. **pi-agent-core's `Agent` is already multi-tenant-ready.** Verified: per-instance state, per-instance model, per-instance API key, no statics, no module-level mutable singletons in agent-core. There is no need for Pixies to wrap it for multi-tenancy.

5. **SSE-fitted core imposes server overhead on the TUI.** Spinning up a localhost HTTP server to talk to itself is unjustified for a single-user CLI. Coupling the TUI to HTTP semantics (cookies, headers, port binding) is unjustified.

6. **SSE-fitted core couples the contract to a single transport.** Future adapters (WebSocket, gRPC, embedded library, CLI pipe) would have to bend the SSE protocol or reimplement the core.

## Consequences

**Positive:**

- TUI stays in-process, zero transport overhead.
- Core is trivially testable (factory returns a configured `Agent`).
- SSE protocol concerns (heartbeat, framing, conversation registry) live in the SSE adapter, leak-free.
- Adding new adapters is mechanical: import core, drive `Agent`.

**Negative:**

- Two adapters to maintain instead of one client of one server.
- Core cannot enforce cross-adapter invariants (e.g. "all conversations expire after 1h") — each adapter owns its own lifecycle. This is acceptable: the TUI has no notion of TTL, and trying to impose one would be a leak.

## Alternatives considered

**SSE-fitted core (rejected).** See rationale above.

**Pixies-specific `Conversation` abstraction over `Agent` (rejected).** Fails the deletion test — adapters lose nothing by using `Agent` directly. Introducing an abstraction layer that mirrors `Agent`'s API is premature; only introduce it if Pixies develops real cross-cutting concerns that `Agent` doesn't address.

**Monolithic single binary with feature flag (rejected).** A single package where a `--server` flag flips to server mode. Conflates deployment with architecture; same adapter code, less clear ownership. A monorepo with separate packages provides clearer boundaries.
