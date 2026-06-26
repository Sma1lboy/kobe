---
"@sma1lboy/kobe": patch
---

Make `tasks.json` writes safe across concurrent kobe processes. The TUI, daemon and CLI all write the same task manifest; previously each save serialized its whole in-memory snapshot, so two processes racing (e.g. a `kobe api` create while the TUI was open) could silently clobber each other — one process's brand-new task vanished on the next save. Writes now take a short-lived PID lockfile (the previously-dead `lockfile.ts`) for mutual exclusion and do a read-merge-write: each save re-reads the on-disk manifest fresh and merges only this process's own changes on top, so concurrent creates both survive, a peer's deletion is not resurrected, and our own deletion is not undone by a stale copy.
