---
"@sma1lboy/kobe": patch
---

Drag-copy to the system clipboard survives an oh-my-tmux config rewrite. The workspace's copy-mode bindings (`copy-pipe-and-cancel pbcopy` on drag-release / `y` / Enter) could be silently rewritten by a user tmux.conf: oh-my-tmux's apply step, with its default `tmux_conf_copy_to_os_clipboard=false`, strips the clipboard command off every `copy-pipe*` binding, leaving a bare `copy-pipe-and-cancel` that never reached the OS clipboard — so drag-copy broke in panes without their own mouse handling (codex, plain shells) while Claude Code's built-in selection masked it. kobe now also sets tmux's `copy-command` option to the resolved clipboard tool; on tmux ≥ 3.2 a bare `copy-pipe` falls back to `copy-command`, so the copy lands in the system clipboard even after the rewrite.
