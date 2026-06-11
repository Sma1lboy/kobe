---
"@sma1lboy/kobe": patch
---

Fix engine-switch and lifecycle correctness in the tmux session layer: an in-place vendor switch (Tasks pane `v` then re-enter) now re-pins each chat-tab window's engine session id and respawns the Ops panes, so per-tab turn status, the `● new` activity badge, and tab auto-naming track the new engine instead of silently reading the old vendor's transcripts for the session's remaining life (KOB-232). The Ops activity badge also backs its transcript poll off toward 20s when idle, and the kobe-home Tasks rail now inherits the right environment so it can't read the wrong `tasks.json`.
