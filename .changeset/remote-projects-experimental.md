---
"@sma1lboy/kobe": patch
---

Add experimental SSH-backed remote projects, off by default behind Settings → Dev → Experimental → Remote projects. When enabled, register a project whose git worktrees and engine run on a remote host over SSH (`kobe add --remote --host … --user … --path … [--port N] [--key [path] | --password]`) — clicking it or creating a task materialises the worktree on the remote and launches the engine in a local tmux pane via SSH, while kobe, tmux, and the daemon stay local. The SSH password is held only in the macOS keychain, never in state, argv, or the pane command. Still in testing: a remote task's file/diff panes degrade for now, and it has not yet been exercised against a live host, so it stays dark until you opt in.
