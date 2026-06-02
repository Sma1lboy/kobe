---
"@sma1lboy/kobe": patch
---

Stop the file/changes panes from racing the engine for `.git/index.lock`.

The sidebar's per-row `+N −M` chip polls `git status` every 2s, and the file-tree and Ops panes run `git status`/`git diff` on demand. Those commands aren't purely read-only — git opportunistically rewrites `.git/index`'s stat cache, which takes `.git/index.lock`. Running on a poll across every worktree (and across multiple ChatTab pane processes) meant they could collide with the worktree's own engine `git commit`/`git add`, surfacing as intermittent `fatal: Unable to create '.git/index.lock': File exists` errors.

All pane-side inspection git calls now run with `GIT_OPTIONAL_LOCKS=0`, so they inspect without writing the index or taking the lock. Real writes (engine commits, worktree create/remove, branch rename) are unaffected and still lock as they should.
