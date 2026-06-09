---
"@sma1lboy/kobe": patch
---

**Archiving now asks first, and custom engines no longer look frozen.** Pressing `a` to archive an active task now shows a confirm ("Archive … and stop its running session?") before it acts, so you can't lose a live engine session to a stray keystroke — archiving still stops the task's running session (an archived task shouldn't keep an engine subprocess burning resources), but the worktree, branch, and chat history stay on disk and the session is rebuilt when you unarchive. Un-archiving stays instant (no confirm). And a task running on a custom (user-added) engine, which kobe can't read activity for, now shows a neutral dim "no activity tracking" affordance instead of a perpetually-idle badge that looked like the task was stuck.
