# ADR 0003 - The daemon owns the web transport; the bridge is transitional

- Status: accepted
- Date: 2026-06-18

## Context

`kobe web` currently reaches daemon state through a standalone `kobe-web/server`
bridge. The browser talks HTTP/SSE to the bridge, and the bridge talks JSON-lines
to the daemon socket. That shape was useful while the dashboard was moving fast:
web route code could hot-restart without touching the daemon, and the daemon did
not need to expose browser-facing routes.

The module has become shallow. Its interface is almost as large as its
implementation: it owns the HTTP route table, daemon socket subscription,
allowed RPC forwarding, SSE snapshot fan-out, session launch specs, notes,
diffs, themes, issue asset routes, and static hosting. The deletion test says
the complexity would reappear in every web host unless the daemon becomes the
HTTP/SSE seam.

## Decision

The daemon is the long-term owner of the local web transport. Browser and
desktop front ends should talk directly to a daemon-hosted loopback HTTP/SSE or
WebSocket interface for daemon-backed data and mutations. The `kobe-web/server`
bridge is a transitional adapter, not a product seam.

The target shape is:

- `kobe daemon` exposes local HTTP RPC plus event streaming for the same
  daemon-owned channels and mutations it already owns on the socket protocol.
- The web SPA and desktop shell use that daemon interface directly.
- Vite remains a dev-only static asset/HMR host and may proxy to the daemon in
  development.
- The PTY sidecar may remain a Node adapter while `node-pty` requires Node, but
  its lifecycle and launch-spec requests should be routed through the daemon
  interface rather than through a separate bridge.
- The bridge may keep existing routes during migration, but new daemon-backed
  browser routes should be added to the daemon interface first.

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
- Migration should happen route-by-route. Start with `/events` and `/api/rpc`,
  because they are the core daemon-backed paths. Then move session/spec routes,
  settings/themes/history/notes/diff, and finally static hosting/desktop wiring.
