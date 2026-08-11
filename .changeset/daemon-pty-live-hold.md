---
"@sma1lboy/kobe": patch
---

The daemon no longer idle-stops while a hosted engine session is still running. Previously, closing the last TUI shut the daemon down 3s later even though hosted PTYs (which live in the standalone pty host) kept running — every `kobe hook` activity event they fired during the gap was dropped, and the in-memory activity registry came back empty on the next launch, blanking the running/attention dots until the next turn boundary. A new keep-alive hold (`pty-live-hold.ts`) polls the pty host for live sessions and defers the idle-stop while any exist, releasing it (and letting the normal lazy shutdown proceed) once the last session's child exits.
