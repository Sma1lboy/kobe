---
"@sma1lboy/kobe": patch
---

Fix: an open web Board now reflects live cross-surface issue edits (from the TUI, `kobe api issue-*`, or another browser) even when the repo path is symlinked. The daemon keys an `issue.snapshot` by the repo's realpath'd git main worktree, which can differ from the board's raw `task.repo` key by more than a trailing slash — so trailing-slash normalization alone missed the push and the column only updated after a manual refresh. The live-push matcher now also matches by the canonical repoRoot a prior GET resolved for that board key.
