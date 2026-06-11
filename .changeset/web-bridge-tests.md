---
"@sma1lboy/kobe": patch
---

Internal: the bridge's HTTP route handler is extracted from `Bun.serve` into a testable `createRequestHandler` (injectable link + teardown), and a new integration suite covers the whole browser-facing surface against a fake daemon link — the `/api/rpc` allowlist (forward / 403 / 400 / 500) and the archive/delete teardown hook (delete and archive tear down, un-archive and rename do not), the SSE snapshot + sink registration, and the `/api/engines` / `/api/themes` / `/api/history` routes. No behavior change; this is the regression net for the surface the recent web waves added. The kobe-web architecture is now documented in `docs/design/web-dashboard.md`.
