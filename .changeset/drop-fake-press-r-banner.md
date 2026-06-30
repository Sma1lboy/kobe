---
"@sma1lboy/kobe": patch
---

fix: the "Engine exited" banner no longer tells you to "press R to relaunch" — a key that was never wired. When an engine pane exits non-zero it drops to a fallback shell and prints the exit code; the banner promised an `R` relaunch shortcut that does not exist (the terminal pane forwards bare keys straight to the shell, so `R` just typed an `R`). The banner now points only at Settings → Engines to fix the launch command, which is the action that actually exists.
