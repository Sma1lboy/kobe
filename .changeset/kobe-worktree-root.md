---
"@sma1lboy/kobe": patch
---

kobe-created task worktrees now live under `~/.kobe/worktrees/<repo-key>/<slug>/` instead of a hidden directory inside the source repo, so users no longer need repo-level `.gitignore` entries for kobe runtime worktrees. Existing repo-local `.kobe/worktrees` and `.claude/worktrees` tasks remain recognized by listing, slug allocation, and daemon auto-adoption, so current task records keep working without migration.
