---
"@sma1lboy/kobe": patch
---

Closing a ChatTab (ctrl+w) now SIGTERMs the window's pane process groups before tearing down the tmux window, the same ladder `killSession` already used for a whole-task kill. Previously it went straight to plain `kill-window`, which only sends tmux's own SIGHUP — an engine CLI that ignores SIGHUP (the real `claude` CLI does) survived as an orphan reparented to init, invisible to `list-panes` but still burning CPU. Same fix applied to the exited-engine tab-replacement path (`kobe engine-tab-exit`), which had the identical gap.
