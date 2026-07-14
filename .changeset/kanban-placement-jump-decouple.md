---
"@sma1lboy/kobe": patch
---

Kanban start: jump-or-stay is now its own toggle (AFTER START — stay on the board / jump to the session), decoupled from placement, and the three placements purely describe where the session runs: a new worktree task with its own workspace, a new worktree presented as a chattab inside the project workspace (viewport tab attached to the task's session), or a new chattab on the project checkout. Every combination launches the engine immediately; the project-checkout start now always opens its own chattab, so a busy first tab can no longer swallow the story prompt.
