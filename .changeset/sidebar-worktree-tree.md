---
"@sma1lboy/kobe": patch
---

Sidebar as a tree: project → worktree → tab, with the right pane showing nothing but the active terminal. Tabs are rows under their worktree (everything starts expanded; `h`/`l` fold what you don't want to see), `enter` on a tab row switches straight to it, and the horizontal tab strip is retired by default (Settings → General → Terminal brings it back, or switch back to the flat sidebar there).

`/` searches the tree: on top of task titles it matches a worktree's branch and a tab's live title, so "which tab is running that thing" is now a question the sidebar can answer. Matches keep their project and worktree so a hit is never orphaned, and the query ignores whatever you had folded shut. `ctrl+p` focuses the cursor row's project by folding the others, and unfolds them on a second press.
