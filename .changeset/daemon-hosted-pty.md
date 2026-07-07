---
"@sma1lboy/kobe": patch
---

Embedded terminal sessions now survive quitting kobe. The daemon hosts the raw PTY (protocol v4: `pty.*` requests + targeted `pty.data`/`pty.exit` frames) with a per-session scrollback ring buffer; the TUI keeps VT emulation local and reattaches on next boot with a full replay — the tmux-persistence behavior without tmux. Quitting the TUI detaches instead of killing; closing a tab, resetting, or archiving a task still ends the session, and a live background session keeps the daemon running. `KOBE_TERMINAL_BACKEND=bun-pty` restores the old local-child backend.
