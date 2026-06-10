---
"@sma1lboy/kobe": patch
---

The deprecated outer monitor is removed. `kobe` now launches straight into the task session flow — there is no opentui shell in front of it anymore. The monitor's two surfaces go with it: the Live Preview (switching sessions inside tmux *is* the preview, and the Tasks pane carries status badges) and the Cost Dashboard (dropped without a port). The `KOBE_OUTER_MONITOR=1` and `KOBE_NO_DAEMON=1` escape hatches are retired too — the daemon is the product, and `kobe doctor` / `kobe reset` cover its failure modes. Keymap rows only the monitor registered (`palette.open`, `app.copy_or_quit`, `focus.next`/`focus.prev`, `pane.resize-*`) are removed from the keybindings table; everything the in-session Tasks/Ops panes and the tmux layer register is unchanged.
