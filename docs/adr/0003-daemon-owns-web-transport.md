# ADR 0003 - The daemon owns the web transport

- Status: implemented
- Date: 2026-06-18

## Context

`kobe web` used to reach daemon state through a standalone `kobe-web/server`
bridge. The browser talked HTTP/SSE to the bridge, and the bridge talked
JSON-lines to the daemon socket. That shape was useful while the dashboard was
moving fast: web route code could hot-restart without touching the daemon, and
the daemon did not need to expose browser-facing routes.

The module has become shallow. Its interface is almost as large as its
implementation: it owns the HTTP route table, daemon socket subscription,
allowed RPC forwarding, SSE snapshot fan-out, session launch specs, notes,
diffs, themes, issue asset routes, and static hosting. The deletion test says
the complexity would reappear in every web host unless the daemon becomes the
HTTP/SSE seam.

## Decision

The daemon is the owner of the local web transport. Browser and desktop front
ends talk directly to a daemon-hosted loopback HTTP/SSE interface for
daemon-backed data and mutations. The `kobe-web/server` bridge is not a product
seam.

The target shape is:

- `kobe daemon` exposes local HTTP RPC plus event streaming for the same
  daemon-owned channels and mutations it already owns on the socket protocol.
- The web SPA and desktop shell use that daemon interface directly.
- Vite remains a dev-only static asset/HMR host and may proxy to the daemon in
  development.
- The PTY sidecar remains a Node adapter while `node-pty` requires Node, but
  its lifecycle and launch-spec requests route through the daemon interface.
- The legacy bridge code may remain temporarily as dead compatibility source,
  but new daemon-backed browser routes must be added to the daemon interface.

## Consequences

- The chain shortens from `SPA -> bridge -> daemon socket` to
  `SPA -> daemon HTTP/SSE`, improving locality for daemon state bugs and making
  request tracing easier.
- Web safety checks (loopback bind, Origin/token policy, RPC allowlist, event
  channel filtering) move to one daemon-owned interface instead of living in a
  separate adapter.
- Hot-reload convenience is no longer a reason to keep daemon-backed behaviour
  outside the daemon. During development, Vite can reload the SPA while the
  daemon interface stays stable.
- The old bridge adapter should not be wired into dev, desktop, CLI, or package
  builds. Static hosting, dev proxies, PTY launch specs, RPC, and SSE all point
  at the daemon web transport.
