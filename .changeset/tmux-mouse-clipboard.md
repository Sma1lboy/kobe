---
"@sma1lboy/kobe": patch
---

Pane-aware mouse drag now copies to the system clipboard. The tmux workspace enables `set-clipboard on` and binds copy-mode finish actions (drag-release plus `y`/Enter) to `copy-pipe-and-cancel` via the platform clipboard tool (pbcopy / wl-copy / xclip / xsel), so a normal left-drag selection reaches the OS clipboard without falling back to Option+drag (which bled across panes). Falls back to OSC 52 when no local clipboard tool is found.
