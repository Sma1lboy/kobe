---
"@sma1lboy/kobe": patch
---

feat: the pure-tui workspace host now opens the update page (`u`) as an in-place swap, same shape as the worktrees page, instead of leaving it unreachable there. `UpdatePage` gained an `onClose` seam so its close path no longer exits the whole process; the post-update self-replace still hands off to the shell updater and exits, but now shows a status line first.
