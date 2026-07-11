---
"@sma1lboy/kobe": patch
---

Native workspace Changes tab can now show a task's whole branch vs its base, not just uncommitted work — so a task's output stays visible after the engine commits it. Press `b` to toggle the Changes tab between working-tree and vs-base scope (it auto-picks vs-base when the worktree is clean), and `d` to open any file's read-only diff in a workspace tab (a content swap that keeps focus on the file tree). The base is the task's PR base when it has one, else the repo's default branch.
