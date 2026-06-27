---
"@sma1lboy/kobe": patch
---

fix: move `node-pty` to runtime dependencies so `kobe web` works on global installs

The `kobe web` PTY sidecar (`dist/web-ui/pty-server.mjs`) imports `node-pty` at
runtime, but it was declared under `devDependencies`, so a published `npm i -g
@sma1lboy/kobe` never installed it and `kobe web` crashed with
`ERR_MODULE_NOT_FOUND: Cannot find package 'node-pty'`. Moved it to
`dependencies`.
