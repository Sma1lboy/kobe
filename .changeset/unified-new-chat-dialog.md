---
"@sma1lboy/kobe": patch
---

Unified new-conversation dialog (issue #7): `ctrl+e` now opens one dialog for every "start a new chat" shape. The default state is the old engine/shell picker verbatim — enter still opens a fresh tab in this worktree. Inside the dialog, `tab` flips the destination (new tab here ⇄ fork a child task worktree) and `ctrl+f` flips the context (fresh ⇄ continue this conversation), with both states always visible in the footer. `ctrl+a c` and `ctrl+a f` remain as preset entries into the same dialog (context/destination pre-flipped); `ctrl+t` is untouched. Fork-destination + continue-context seeds the child task's first prompt with the transcript handoff brief. Also: the claude/codex history readers now honor `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, matching the account probes.
