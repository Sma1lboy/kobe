---
"@sma1lboy/kobe": patch
---

Fixed a bug where adding a remote (`ssh://`) project silently broke live engine activity for every task — the worktree auto-adoption check fed the remote project's synthetic key into a path helper that only accepts absolute paths, throwing and dropping the entire engine event, so task status, transcript, and telemetry stopped updating until the remote project was removed.
