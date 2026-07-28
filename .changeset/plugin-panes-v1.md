---
"@sma1lboy/kobe": patch
---

Plugin panes v1: a `[[panes]]` manifest section plus `kobe plugin pane open --plugin <id> --entrypoint <pane-id>` opens the pane's command as a self-closing terminal tab in the task workspace of the running TUI (new `tab.open` RPC + channel; cwd is the task worktree, `$KOBE_PLUGIN_ROOT` expands in commands). Ships an `examples.lazygit` pane plugin and an `examples.linear-start` action plugin (fzf-pick a Linear issue → task on its branch).
