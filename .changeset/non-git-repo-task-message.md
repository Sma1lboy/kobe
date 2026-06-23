---
"@sma1lboy/kobe": patch
---

Friendlier, actionable error when a task's folder isn't a git repo. Instead of leaking git's bare `fatal: not a git repository`, both the new-task dialog's inline validation and the worktree-creation toast now explain why a task needs a git repo and hand over the exact fix (`git init && git add -A && git commit -m "init"`), noting that non-git folders will be supported later.
