---
"@sma1lboy/kobe": patch
---

Background panes now throttle their render loop: while a pane's tmux session
has no attached client, the opentui targetFps drops to 2 (restored within ~3s
of re-attach), cutting the remaining idle burn of invisible panes on top of
the attach-gated pollers. Applied once in the shared pane-host boot, so every
current and future pane host gets it.
