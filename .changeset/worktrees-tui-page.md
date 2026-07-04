---
"@sma1lboy/kobe": patch
---

feat: standalone worktree management page (`x` from the Tasks pane sidebar)

Lists every local saved project's git worktrees in one full-window tab, mirroring `kobe settings`'s shape: kobe-managed vs adopted, dirty state, whether the branch has reached `origin`, and how long ago the worktree was created. Deleting a worktree with uncommitted/untracked changes needs a second, more severe confirmation before force-deleting.

New daemon RPCs `worktree.list` / `worktree.remove` back the page; `handlers.ts` was split by domain (`handlers-task.ts` / `handlers-worktree.ts`) to add them within the repo's file-size cap.
