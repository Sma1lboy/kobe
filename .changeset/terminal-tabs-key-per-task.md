---
"@sma1lboy/rove": patch
---

fix: key the workspace TerminalTabs by task, not worktree path — two tasks sharing the same directory (a project-main task plus a dir task on one checkout) reused the mounted component across a task switch, so the previous task's tab state was written under the new task's snapshot key, cloning phantom chattabs (and spawning fresh engine sessions) into the other task on every click.
