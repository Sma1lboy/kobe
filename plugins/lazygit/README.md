# examples.lazygit

The smallest possible pane plugin: one `[[panes]]` entry that opens
[lazygit](https://github.com/jesseduffield/lazygit) on the task's worktree
as a terminal tab in the running TUI.

```bash
kobe plugin install Sma1lboy/kobe/plugins/lazygit
kobe plugin pane open --plugin examples.lazygit --entrypoint git   # active task
```

The tab closes itself when lazygit exits. Requires `lazygit` on PATH.
