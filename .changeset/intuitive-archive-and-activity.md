---
"@sma1lboy/kobe": patch
---

**Archiving a task is now actually non-destructive, and custom engines no longer look frozen.** Pressing `a` to archive a task no longer kills its running tmux/engine session — the worktree, branch, chat history, AND the live session all stay, so un-archiving brings the task back intact (delete still tears the session down, as it should). And a task running on a custom (user-added) engine, which kobe can't read activity for, now shows a neutral dim "no activity tracking" affordance instead of a perpetually-idle badge that looked like the task was stuck.
