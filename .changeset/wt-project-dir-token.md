---
"@sma1lboy/kobe": patch
---

The "Worktree location" setting (Settings → General) now understands a leading `$project_dir` token that expands to each task's project root when the worktree path is computed — so one global setting like `$project_dir/../` keeps every repo's worktrees next to that repo. `..` segments are collapsed after expansion, the per-repo `<repo>-<hash>` subfolder is still appended so repos sharing a parent directory never collide, and the default `~/.kobe/worktrees` root stays recognized for listing pre-existing tasks. The token only expands as the first path segment (the settings dialog rejects other placements), and existing worktrees stay where they are.
