---
"@sma1lboy/kobe": patch
---

The daemon no longer freezes while git works: worktree operations (`git worktree add` on task open, remove, dirty checks, branch renames) used to run as synchronous subprocesses inside the daemon process, so materialising a worktree on a very large repo stalled every connected pane's RPCs and live updates for the duration. ExecHost's expensive operations (run/exists/readFile/readdir) are now async — the daemon keeps serving all clients while git churns in the background.
