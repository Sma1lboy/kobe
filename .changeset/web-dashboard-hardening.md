---
"@sma1lboy/kobe": patch
---

fix: harden the kobe-web dashboard and PTY sidecar

The browser dashboard now self-heals after a daemon restart: the SSE client nulls out a CLOSED EventSource (so the next subscribe re-opens instead of wedging on "connecting…") and drives a bounded backoff reconnect, and every `snapshot`/`channel` frame is shape-validated before it touches the store so a malformed/partial frame is dropped+logged instead of crashing on the next `.map`/`.find`. The node-pty sidecar caps concurrent sessions (evicting the oldest unwatched tab, rejecting when all are in active use) and applies PTY→WebSocket backpressure (pausing a flooding pty once any socket saturates, resuming once every socket drains) so a runaway terminal can't grow node memory unbounded.
