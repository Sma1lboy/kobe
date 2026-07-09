---
"@sma1lboy/kobe": patch
---

fix: `kobe add` (and every task-creation path) now provisions the repo's project row

The sidebar's PROJECTS entries are the repos' `kind:"main"` tasks, but nothing in the daemon world created them — `kobe add` saved the repo and adopted worktrees (tasks appeared live) while the PROJECTS list never updated. `kobe add` now ensures the main task, via the daemon when one runs so a live TUI shows the project immediately; `createTask`/`adoptWorktree` also self-provision it, so the new-task dialog on a brand-new repo and hook-adopted worktrees get their project row too.
