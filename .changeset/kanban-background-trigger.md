---
"@sma1lboy/kobe": patch
---

Kanban background Start now actually launches the engine session: the story's task is created, the engine spawns immediately in the hosted PTY with the story prompt (including the self-report `issue-set-status` instruction), and you stay on the board — In-progress cards show a live activity badge (working / turn done / needs permission / rate limited / error) from the engine-state channel, and visiting the task later attaches to the same running session. Background start is now the detail drawer's default placement.
