---
"@sma1lboy/kobe": patch
---

Deleting a worktree no longer freezes the worktrees page. `git worktree remove` on a worktree with a populated `node_modules` is seconds of real filesystem work, and both the TUI and web pages awaited it before updating. The row now disappears the moment you confirm, the removal runs in the background, and a failure puts the row back (still routing a dirty worktree to the force-delete confirm).
