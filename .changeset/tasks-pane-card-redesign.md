---
"@sma1lboy/kobe": patch
---

Redesign the Tasks pane (sidebar) and tidy the file-changes pane. Tasks now
render as compact two-line cards with a left accent bar + subtle tint for the
cursor (replacing the heavy full-row fill), split into two labelled sections —
`PROJECTS` (repo roots, with their dir) on top and `TASKS` (worktrees) below.
The `working` chip + animated spinner now surface a task's in-progress state.
Panes sit flush to their tmux edges (horizontal padding removed), the footer
key legend right-aligns its descriptions in a capped column, and Changes-tab
paths tail-truncate so the filename always shows. The version/update chip moved
up into the new `KOBE` brand header; the footer `system` section is gone. The
file-changes pane's row selection now matches the sidebar — a left accent bar
+ subtle tint instead of a solid fill.
