---
"@sma1lboy/kobe": patch
---

Make pane hosts crash-resilient: a single rejected fire-and-forget promise or a render-tree throw no longer drops a `kobe <pane>` process to a raw shell. Each pane now installs a process-level `unhandledRejection`/`uncaughtException` net that logs to `client.log` instead of exiting (mirroring the daemon), and the host view tree is wrapped in a Solid `ErrorBoundary` that paints a themed "this pane crashed — reload" placeholder.
