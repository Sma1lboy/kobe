---
"@sma1lboy/kobe": patch
---

Fix: a terminal/engine tab no longer briefly double-renders on (re)attach. The PTY sidecar added the new WebSocket to the live fan-out set *before* replaying scrollback, so a chunk arriving in that window was both sent live and included in the replay — the browser wrote the same bytes twice, momentarily garbling the screen during heavy streaming. The scrollback is now snapshotted before the socket joins the fan-out, making attach exactly-once.
