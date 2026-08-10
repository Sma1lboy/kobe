---
"@sma1lboy/kobe": patch
---

The behavior suite now skips its PTY-driven pins where `node-pty` is installed but cannot spawn (a sandboxed shell denies `posix_spawnp`), instead of failing with an environment error that looks like a product regression — which also blocked releases on such a machine. CI has a real PTY, so coverage there is unchanged.
