---
"@sma1lboy/kobe": patch
---

PTY parking: hidden terminal tabs release their in-memory terminal after 2 minutes.

Every open tab used to keep a full headless-xterm instance (live grid + scrollback) resident for the life of the TUI — the workspace host sat at 250-300MB with many tabs and was the first process killed under memory pressure. The registry now sweeps every 30s and detaches handles that have had no visible pane for 2 minutes; the engine/shell keeps running untouched in the pty host, whose byte ring buffer remains the authoritative history. Switching back reattaches and replays — the exact same path a TUI restart uses, so revived content is identical. Visible panes, split leaves, and non-persistent backends are never parked, and sending a prompt to a parked engine tab transparently wakes it first.
