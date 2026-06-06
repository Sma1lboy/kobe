---
"@sma1lboy/kobe": patch
---

kobe-created task worktrees now live under `<repo>/.kobe/worktrees/<slug>/` instead of `<repo>/.claude/worktrees/<slug>/`, so the task filesystem layout is no longer named after a single CLI engine. Existing `.claude/worktrees` tasks remain recognized by listing, slug allocation, and daemon auto-adoption, so current task records keep working without migration.
