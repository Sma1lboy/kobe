---
"@sma1lboy/kobe": patch
---

Web Board issue execution is now scoped to one current project instead of an all-projects kanban: the project selector is a compact repo dropdown (not a row of tabs), is always present when projects exist, includes empty saved projects, and issue starts create worktrees under that selected project. Linked issue drawers also gain a Prompt merge action that inserts a finish/merge prompt into the issue task, asking the agent to summarize, verify, merge back into the current project's main branch, and mark the issue done.
