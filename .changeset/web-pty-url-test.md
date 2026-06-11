---
"@sma1lboy/kobe": patch
---

Internal: cover `ptyUrl` — the PTY WebSocket URL builder (the `port + 2` sidecar convention, ws/wss by page scheme, and the tab/taskId/mode/cols/rows query params xterm sends). A regression here would break every terminal tab. 107 web tests.
