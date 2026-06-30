---
"@sma1lboy/kobe": patch
---

fix: a task's workspace layout now re-pins itself after you exit a terminal pane. Closing a workspace-split terminal (typing `exit`) hands its cells to a neighbouring pane, which knocks the fixed-width Tasks rail and the right column off their pinned geometry — the same disorder a terminal resize causes, except `window-resized` never fires because the window size is unchanged. Until now the only recovery was switching to another task and back (which heals on switch-in), so the currently-focused task stayed visually broken until you dragged the panes back yourself. kobe now heals the layout on tmux's `pane-exited` hook, re-pinning the rail and right column to the shared globals the moment a pane closes.
