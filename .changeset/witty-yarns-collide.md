---
"@sma1lboy/kobe": patch
---

**Conflict radar on the board** — cards whose branches truly collide are now connected by colored yarn lines on `/board`: the daemon dry-runs `git merge-tree --write-tree` between in-flight task heads (after a cheap touched-file-overlap prescreen), publishes pairs over a new `task.conflicts` channel, and the board draws a drooping line per conflicting pair with a hover tooltip naming both tasks and the clashing files; overlapping/conflicting cards also carry a ⚠ badge. Every radar git call is strictly non-blocking — async spawns with `GIT_OPTIONAL_LOCKS=0` (never takes `.git/index.lock` from under an engine's own commit), a global cap of 3 concurrent git children, per-card adaptive scheduling with timeout + backoff, and merge probes cached by head pair so they rerun only on new commits. On git < 2.38 the radar degrades to file-overlap badges (no yarn) instead of erroring.
