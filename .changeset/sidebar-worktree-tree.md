---
"@sma1lboy/kobe": patch
---

Sidebar as a tree: project → worktree → tab, with the right pane showing nothing but the active terminal. Tabs are rows under their worktree (everything starts expanded; `h`/`l` fold what you don't want to see), `enter` on a tab row switches straight to it, and the horizontal tab strip is retired by default (Settings → General → Terminal brings it back, or switch back to the flat sidebar there).

`prefix+m` reorders **projects** in the tree — `j`/`k` drag the cursor row's whole project group, `enter`/`esc` leave. Sorting is gone from the tree: the structure already carries an order, and manual placement is what move mode is for.

Right-click a tree row for its menu: a worktree offers open / expand / rename / pin / merge / archive / delete, a tab row opens that tab and carries its worktree's verbs, and a project header offers collapse, focus, and new task. Every entry is a route to something the row's keys already did — `j`/`k` move the highlight, `enter` picks, `esc` closes.

`/` searches the tree: on top of task titles it matches a worktree's branch and a tab's live title, so "which tab is running that thing" is now a question the sidebar can answer. Matches keep their project and worktree so a hit is never orphaned, and the query ignores whatever you had folded shut. `ctrl+p` focuses the cursor row's project by folding the others, and unfolds them on a second press.
