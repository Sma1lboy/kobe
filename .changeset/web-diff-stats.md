---
"@sma1lboy/kobe": patch
---

The web diff view now shows change-size stats: a `+a −d` chip in the full Changes header (summed across files), in each file-preview header (that file's counts), and the daemon's worktree total in the right-rail Changes list — so the scale of an agent's changes is visible at a glance. Counts come from the same unified-diff parser (excluding the `+++`/`---` file-header lines), covered by tests.
