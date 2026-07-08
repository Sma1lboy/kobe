---
"@sma1lboy/kobe": patch
---

fix: chat-tab close and engine-tab exit now SIGTERM the window's pane process groups before `kill-window` (the same ladder whole-task kills use), so HUP-swallowing engines and pane hosts no longer leak to init. The sweep skips the caller's own group — `kobe engine-tab-exit` runs inside a pane of the window it closes.
