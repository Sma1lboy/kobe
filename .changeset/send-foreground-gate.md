---
"@sma1lboy/kobe": patch
---

`kobe api send` gates delivery into an existing tab on a live engine process (herdr's foreground check, ported to the process tree). A session's spawn argv says what was launched, not what is running: an engine that exited into the keep-alive shell used to receive the pasted prompt as shell commands. Both the canonical path and `--tab tab-N` now walk the PTY child's process tree first and refuse with typed `ENGINE_NOT_RUNNING` (hint + `--tab new` recovery argv) when only a shell remains. Any registered engine passes — the addressed tab may run a different vendor than the task, so cross-vendor send stays open.
