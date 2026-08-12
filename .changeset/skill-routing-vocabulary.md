---
"@sma1lboy/kobe": patch
---

The agent skill now defines Task / Worktree / Terminal Tab / Split in the words users actually say, states the isolation each level gives (new task = own worktree + branch, new tab = own session but the SAME files, split = layout only), and routes each phrasing explicitly: "in this workspace/here" opens a tab in the current worktree rather than the new task an instruction with no location word still gets. Adds the one read (`get-task`) that answers "what is my worktree, my branch, which sibling tabs exist". Skill version 18 — run `kobe skill install` to pick it up.
