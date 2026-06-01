---
"@sma1lboy/kobe": patch
---

fix: daemon now shuts down on quit even with many ChatTab windows open

The refcounted lazy-shutdown counted every subscribed client, including the
in-tmux helper panes (Tasks pane, Ops, settings/new-task windows) that each
ChatTab window spawns. Those panes persist with the tmux session after the user
quits kobe, so with several ChatTabs open the subscriber count never reached
zero and the daemon stayed alive forever. `subscribe` now carries a role: only
the front-end attach (`role: "gui"` — `kobe` parked on `tmux attach`) holds the
daemon alive; helper panes subscribe as `role: "pane"` for live data without
keeping it running. Quitting the last GUI now reliably idle-stops the daemon.
