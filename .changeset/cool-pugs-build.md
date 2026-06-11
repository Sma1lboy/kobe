---
"@sma1lboy/kobe": patch
---

**Fix `kobe web` crashing at startup in the packaged build** — the PTY server in `dist/web-ui/` imports its sibling `pty-scrollback.mjs` (the bounded-scrollback ring from 0.7.22), but the build script only copied `pty-server.mjs`, so the npm-installed `kobe web` died with `ERR_MODULE_NOT_FOUND` before serving anything. The build now ships every sibling module the PTY server imports.
