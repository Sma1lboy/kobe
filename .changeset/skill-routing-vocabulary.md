---
"@sma1lboy/kobe": patch
---

The agent skill now defines Task / Worktree / chattab in the words users actually say, and states where work lands for each: "in this workspace/worktree/here" means a new chat tab in the SAME worktree (`send --tab new`), while an instruction with no location word stays the default new task with its own worktree and branch. Adds the one read (`get-task`) that answers "what is my worktree, my branch, which sibling tabs exist". Skill version 18 — run `kobe skill install` to pick it up.
