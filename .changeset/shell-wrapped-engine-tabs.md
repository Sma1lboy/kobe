---
"@sma1lboy/kobe": patch
---

Engine tabs now launch inside your real shell: the PTY spawns `$SHELL` and types the engine command into it, so the session keeps your rc-file context (aliases, PATH) and exiting the vendor CLI lands on a normal prompt in the same tab — the engine-to-shell degrade transition is gone. ctrl+w closes an engine tab in one press (it no longer resurrects as a shell first), the last tab recycles in place as a fresh engine when its shell exits, the pty host keeps one pre-warmed shell per worktree so new tabs skip shell startup, and quick-fork prompts ride the engine argv instead of racing a paste.
