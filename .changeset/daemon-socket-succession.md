---
"@sma1lboy/kobe": patch
---

fix: end daemon-succession split brain — a daemon that loses its socket path now stops itself so attached TUIs reconnect to the new owner (issue #10)

Three cooperating guards in the daemon lifecycle: a socket-ownership watchdog
(a daemon whose `daemon.sock` was taken over or removed stops itself, and the
TUI's existing reconnect loop silently migrates to the new owner — no more
re-entering kobe to see new state); ownership-checked shutdown cleanup (a
superseded daemon no longer closes/unlinks the socket path by name, which
deleted the NEW daemon's socket and cascaded into repeated autospawns); and a
cross-process autospawn lock (concurrent clients that all find the daemon
unreachable no longer each run stop+spawn — losers wait for the winner's
daemon).
