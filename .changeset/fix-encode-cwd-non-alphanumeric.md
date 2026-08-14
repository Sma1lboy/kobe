---
"@sma1lboy/kobe": patch
---

Claude tasks whose worktree path contains an underscore, a space, or an accented character now get their session transcript found again: kobe derived Claude Code's on-disk project directory by folding only `/` and `.` to `-`, but Claude folds *every* non-alphanumeric character (its own encoder is `cwd.replace(/[^a-zA-Z0-9]/g, "-")`), so a path like `/home/jane_doe/my_app` pointed kobe at a directory Claude never wrote — silently disabling the activity badge, the turn detector, auto-title, and interrupted-prompt rescue for that task. kobe now matches Claude's encoder exactly.
