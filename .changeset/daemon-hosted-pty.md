---
"@sma1lboy/kobe": patch
---

Embedded terminal sessions now survive quitting kobe AND `kobe daemon restart`. A standalone `kobe pty-host` process (kobe's tmux-server analog, spawned on demand, idle-exits at zero sessions) owns the raw PTYs with a per-session scrollback ring buffer; the TUI keeps VT emulation local and reattaches on next boot with a full replay (protocol v4: `pty.*` requests + targeted `pty.data`/`pty.exit` frames). Quitting the TUI detaches instead of killing; closing a tab, resetting, or archiving a task still ends its session, and `kobe reset` now also stops the pty host. `KOBE_TERMINAL_BACKEND=bun-pty` restores the old local-child backend.
