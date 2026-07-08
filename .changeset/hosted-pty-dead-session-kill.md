---
"@sma1lboy/kobe": patch
---

Quitting claude/codex inside an engine tab now degrades the tab to a shell again instead of closing it. The hosted PTY backend's `kill()` early-returned once the child had already exited, so the pty host kept the dead session record under the tab's key; the degraded shell's `pty.open` then reattached that corpse (spawn spec ignored, `alive: false`) and died instantly, which routed the exit through the command-tab close path. A kill on an already-dead handle now still tells the host to forget the session, which also un-breaks F5 reset of a dead shell and stops dead session records leaking in the host on tab close.
