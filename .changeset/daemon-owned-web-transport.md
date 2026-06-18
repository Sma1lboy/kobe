---
"@sma1lboy/kobe": patch
---

Web and desktop now route browser HTTP/SSE traffic directly through the kobe daemon instead of starting a standalone kobe-web bridge process. The daemon owns the web route table, RPC allowlist, SSE snapshot stream, session/spec routes, and optional static hosting; web dev and desktop only start Vite and the Node PTY sidecar.
