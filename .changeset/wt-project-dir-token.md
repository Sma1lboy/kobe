---
"@sma1lboy/kobe": patch
---

The "Worktree location" setting (Settings → General) is now a preset cycle instead of a bare text field: enter switches between `default ~/.kobe/worktrees`, `next to project` (worktrees land beside each repo), and `custom` — mirroring the editor rows. Under the hood the sibling preset stores a new `$project_dir` token that expands to each task's project root when the worktree path is computed, and the custom path field accepts it too (e.g. `$project_dir/../scratch`) for hand-rolled per-project layouts. `..` segments are collapsed after expansion, the per-repo `<repo>-<hash>` subfolder is still appended so repos sharing a parent directory never collide, and the default root stays recognized for listing pre-existing tasks. New tasks only; existing worktrees stay where they are.
