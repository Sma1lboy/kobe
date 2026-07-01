---
"@sma1lboy/kobe": patch
---

Add a global "Worktree location" setting (Settings → General) to configure where new task worktrees are created. By default kobe stores local worktrees under `~/.kobe/worktrees/<repo>-<hash>/<slug>`; the new free-text field re-roots that base directory to any path you choose (with `~` and relative-path expansion), while keeping the per-repo `<repo>-<hash>` subfolder so worktrees from different repos never collide. The override is read fresh by the daemon on every task create — no restart needed — and applies to new tasks only: existing worktrees keep their recorded path and the old default root stays recognized for listing and slug allocation. Remote (SSH) projects are unaffected; their worktrees still live under the project's remote `basePath`.
