---
"@sma1lboy/kobe": patch
---

Pure-TUI pane navigation: `F4` cycles pane focus (sidebar → workspace → files, forward-only) and is reserved from terminal passthrough, so it behaves identically from every pane including inside the embedded engine terminal — closing the workspace → files two-hop gap. `ctrl+l` (dead slot in the 3-pane host) now focuses the workspace terminal, and `Right` from the sidebar jumps into the engine, matching the tmux Tasks pane. `tab`/`shift+tab` stay with the shell and claude (completion, plan-mode) — deliberately not bound to the cycle.
