---
"@sma1lboy/kobe": patch
---

The sidebar tree now shows tabs for sessions the CLI started, and `--vendor` accepts custom engines.

A task started headlessly (`kobe api add --prompt`, `kobe api send`, a routine firing) ran a live engine that the sidebar could not see: the tree lists a worktree's tabs from the task's persisted snapshot, and only a mounted `TerminalTabs` ever wrote one — so agent-driven work, which is mostly how work enters kobe, rendered as empty worktree rows. The CLI launch path now seeds that snapshot (write-once, so a mounted TUI still owns real tab state), and the tree falls back to the pty host's live session list for anything neither writer covered.

`kobe api set-vendor --vendor <custom-engine>` was rejected before any handler saw it: the flag layer validated against the closed built-in list while the TUI selector offered registered custom engines and the daemon accepted them. Both CLI gates now consult `customEngineIds`.
