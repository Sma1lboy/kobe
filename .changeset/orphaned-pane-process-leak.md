---
"@sma1lboy/kobe": patch
---

Fix orphaned pane-process leak: killed tmux panes left their `kobe tasks` / `kobe ops` helpers (and engine CLIs) running forever. opentui's exit handler catches SIGHUP/SIGTERM but never exits the process, so every `respawn-pane -k` / session teardown reparented the old helper to launchd with a revoked tty — over a hundred zombies burning ~14 GB / 100%+ CPU in a busy week. Hosts now exit shortly after an exit signal (with a 5s grace so kill-own-session flows like the preview toggle still finish), and `killSession` / `kobe kill-sessions` / `kobe reset` SIGTERM each pane's process group before tmux's HUP so engine CLIs that swallow HUP are also reaped.
