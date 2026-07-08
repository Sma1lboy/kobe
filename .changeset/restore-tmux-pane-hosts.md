---
"@sma1lboy/kobe": patch
---

Restore the four tmux pane hosts lost in the Solid removal — `kobe tasks` (the Tasks rail), `kobe new-task`, `kobe quick-task` (prefix+f), and `kobe update-page` printed "unknown command" since 0.7.73 because only their Solid implementations existed when the Solid TUI was deleted. All four are now React hosts under `tui-react/`, wired back into the CLI with routing tests so they can't be dropped silently again.
