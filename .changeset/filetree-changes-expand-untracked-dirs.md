---
"@sma1lboy/kobe": patch
---

File pane Changes tab no longer shows bare directories. `git status --porcelain` collapses a fully-untracked directory into a single `dir/` row, which rendered as a directory with no +/- stats and nothing to open. The pane now runs `git status` with `--untracked-files=all`, expanding untracked directories into their individual files (matching the All tab's `git ls-files --others` enumeration and respecting `.gitignore` the same way); a trailing-slash row is also skipped defensively so a directory can never appear as a change entry.
