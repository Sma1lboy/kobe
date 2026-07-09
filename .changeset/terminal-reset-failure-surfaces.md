---
"@sma1lboy/kobe": patch
---

A terminal reset whose fresh spawn fails now shows the spawn error instead of a dead snapshot.

`registry.reset()` kills the old PTY before spawning the replacement, so when the acquire half threw (shell missing, spawn EACCES) the pane kept rendering the dead shell's last screen while the error message sat in state the UI never showed. The failed-reset path now clears the pane to the same "terminal unavailable" error state as a failed first acquire. Also adds a scripted fake PTY registry (`pty-scripted.ts`) so the pane's error/exit paths are covered by fast render tests with zero subprocesses.
