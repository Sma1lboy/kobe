---
"@sma1lboy/kobe": patch
---

tmux-style split panes inside a terminal tab: ctrl+\ splits right, ctrl+= splits down (new panes run your shell in the same worktree), F3 cycles pane focus, and ctrl+w contextually closes the active split (falling back to close-tab when unsplit). Same-orientation splits insert siblings, cross-orientation splits nest groups, and an exited pane collapses its group; the pane that predates the first split keeps its live engine session. Rendering is tmux-flavored — a single divider line on shared edges (focus-accented), no frames, no padding. The split tree (`split-core.ts`) is deliberately content-agnostic: terminals are the first leaf type, not the only one.
