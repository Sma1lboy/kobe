---
"@sma1lboy/kobe": patch
---

Opening kobe now lands on the last-focused task again instead of the first task in the list.

The orchestrator restores the persisted focus at construction, but the daemon only published the `active-task` channel on an explicit focus change — a fresh daemon's connect-time replay carried tasks and no focus, so every newly attached TUI (and the web dashboard, and `kobe api`'s active-task resolution) fell back to the top of the task list. The daemon now warms the channel with the restored focus at startup, and the workspace host adopts a late-arriving restored focus once (never yanking a selection the user already made). tmux direct mode is untouched — it reads the in-process signal, which was already correct.
