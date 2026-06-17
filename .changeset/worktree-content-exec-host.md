---
"@sma1lboy/kobe": patch
---

Internal: Worktree content reads now go through one ExecHost-backed module instead of each surface spawning local git or reading local files directly. File tree git status/listing, Ops preview diff/code reads, and the web diff route now share the same local/remote Worktree git path, preserving lock-free `GIT_OPTIONAL_LOCKS=0` reads and the web route's timeout behavior while allowing registered remote Worktree paths to be inspected through SSH.
