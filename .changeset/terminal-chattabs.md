---
"@sma1lboy/kobe": patch
---

Workspace terminal tabs (issue #16): the PTY-world chattab. The KOBE_TUI center column now carries a tab strip over the embedded terminal — ctrl+t opens a parallel engine session in the same worktree, ctrl+w closes (the last tab refuses), F2 renames through the real rename dialog, ctrl+]/[ cycle — reusing the canonical chattab binding ids and reserving those chords from PTY passthrough exactly as the tmux root key-table did. Per-task tab state survives task switches; each tab keys its own registry-backed PTY.
