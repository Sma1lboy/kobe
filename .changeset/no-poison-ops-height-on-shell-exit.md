---
"@sma1lboy/kobe": patch
---

fix: closing a task's bottom-right terminal with `exit` no longer squashes the terminal pane across every task. The shell pane has no keepAlive, so typing `exit` really kills it and the Ops pane grows to fill the right column. The layout-capture path (both the live `window-layout-changed` drag gate and the switch-away capture) then read that transient ~100% Ops height and wrote it to the GLOBAL Ops-height option, so every later layout heal re-applied the squashed height to all tasks until a manual re-drag. Capture now bails when the `shell` role is absent (without the hidden-by-toggle flag), so a closed terminal can't poison the saved geometry.
