# kobe desktop

Thin Electron shell for playing with `kobe web` as a desktop app.

```bash
bun --filter kobe-desktop dev
bun --filter kobe-desktop dev:sandbox
```

The shell starts the existing `packages/kobe-web/dev.ts` stack on a free local
port block, opens a BrowserWindow, and stops only the web/bridge/PTY child
processes on exit. It deliberately does not kill the daemon or tmux sessions.
