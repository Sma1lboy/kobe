---
"@sma1lboy/kobe": patch
---

Landing a task with the default merge strategy now refuses a branch that has nothing to land instead of reporting a fake success. A branch with no commits ahead of its base (already merged, or an agent that produced no commits) made `git merge --no-ff` exit cleanly with "Already up to date." and no commit, so `kobe api land` / the worktrees-page `l` key reported it as landed on an unrelated pre-existing commit — and with cleanup enabled would then delete the branch and archive the task. The merge path now detects the unmoved HEAD and throws the same "nothing to land (already merged or empty)" error the squash path already raised.
