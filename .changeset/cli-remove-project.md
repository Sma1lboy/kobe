---
"@sma1lboy/kobe": patch
---

Add `kobe remove [path]` — the inverse of `kobe add`. It forgets a saved project (drops it from the new-task picker) without touching anything on disk: the repo's files, worktrees, branches and tasks all stay. Matching is forgiving — pass a relative path, a subdirectory, or the exact stored entry (so a stray/garbage entry or a remote `ssh://user@host` key is removable verbatim); run with no match to print the current saved projects so you can copy the exact one. Removing a remote project also drops its stored connection config so no orphan `remoteRepos` entry is left behind. Until now there was no way — TUI or CLI — to remove a saved project.
