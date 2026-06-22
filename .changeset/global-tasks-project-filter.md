---
"@sma1lboy/kobe": patch
---

Tasks pane project filtering is now a global UI preference shared across every task session. Pressing `ctrl+p` in one session updates the project scope everywhere, and entering another task no longer reveals that session's stale local filter state.

The Tasks pane also keeps its collapsed keys legend one row above the tmux status bar and splits sidebar overflow into independent PROJECTS and TASKS scroll regions, so a long task list no longer pushes project rows out of view.
