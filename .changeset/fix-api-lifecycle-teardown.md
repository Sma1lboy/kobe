---
"@sma1lboy/kobe": patch
---

Fix `kobe api delete` / `kobe api archive` leaving the task's engine running: scripted delete/archive committed the daemon RPC but never stopped the task's tmux session, so the engine subprocess kept running — orphaned and invisible to every kobe UI since the task was already gone from `tasks.json`, recoverable only via `kobe reset`. Teardown now runs in the CLI process after the RPC commits (the daemon never touches tmux by design), matching the TUI flows: delete always kills the session, archive kills only when archiving.
