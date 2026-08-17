---
"@sma1lboy/rove": patch
---

Scratch adoption now de-dupes against existing tasks (issue #40): a scratch shell whose settled cwd is a main/directory task's directory — or inside a managed task's worktree — folds into that task as a new terminal tab (the running engine session moves with it via a host-side re-key) instead of minting a duplicate sidebar row. Only a cwd no task owns still takes the mint-a-dir-task path. The fold keeps #472's quiet discipline: no dialog, no focus steal, selection follows only when the scratch row was the selected one.
