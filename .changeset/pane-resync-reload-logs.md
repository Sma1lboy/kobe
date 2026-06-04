---
"@sma1lboy/kobe": patch
---

Converge the Tasks-pane create/delete sync drift, add `kobe reload`, and add a client log.

- **Sync fix (no more frozen task lists).** A Tasks pane that subscribed to the daemon at boot used to FREEZE its list when that daemon later went away — the refcounted lazy-shutdown idle-stops the daemon 3s after the last GUI quits, while the pane lives on with the tmux session, and the client had no auto-reconnect and no fallback. Now a `role: "pane"` orchestrator auto-reconnects on socket close (a NON-spawning retry, so it never resurrects an idle-stopped daemon and breaks lazy-shutdown), and the Tasks pane always keeps a `tasks.json` backstop poll that takes over the instant the daemon goes offline. The daemon's snapshot replays on re-subscribe, so the pane re-syncs automatically. A malformed daemon frame can no longer silently kill a client's event delivery (the JSON parse is now guarded).

- **`kobe reload`.** Restarts the in-tmux Tasks + Ops panes across every live session in place (reusing the same `respawn-pane` heal the post-Settings refresh uses) so kobe TUI-layer code changes load WITHOUT `kobe reset` — the engine (claude) panes and your running turns are never touched.

- **Client log.** Panes run inside an opentui alternate-screen, so their stdout was invisible — which is why the sync drift went undiagnosed for so long. Client-side processes now append tagged, timestamped connection-lifecycle lines (subscribe / disconnect / reconnect / fallback) to `<home>/.kobe/client.log`, and the daemon logs the matching socket churn (subscribe/disconnect with role + counts, idle-arm/stop) to `daemon.log`.
