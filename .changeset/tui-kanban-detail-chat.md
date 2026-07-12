---
"@sma1lboy/kobe": patch
---

TUI kanban: card selection + issue detail + start chat. Arrow keys move a highlighted card cursor across the board (tab still cycles projects; ←/→ fall back to project cycling on an empty board), Enter — or clicking the selected card — opens the issue-detail drawer showing the full story, with the quick-task composer's image-paste grammar (paste a file path or ctrl+v a clipboard screenshot) attaching images to the first prompt. From the drawer, start the story's engine session with a chosen vendor at one of three placements: a new worktree task (open it), a new worktree task in the background (its chattab waits under the project group), or directly on the project checkout with no worktree.
