# kobe desktop

Thin Electron shell for playing with `kobe web` as a desktop app.

This workspace is experimental. It exists to try the desktop-app feel quickly;
it is not a product commitment, and future kobe work may change, replace, or
drop this shell if the experiment stops paying for itself.

```bash
bun --filter kobe-desktop dev
bun --filter kobe-desktop dev:sandbox
```

The shell starts the existing `packages/kobe-web/dev.ts` stack on a free local
port block, opens a BrowserWindow, and stops only the web/PTY child processes
on exit. Browser data goes through the daemon web transport. The shell
deliberately does not kill the daemon or tmux sessions.
