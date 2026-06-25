---
"@sma1lboy/kobe": patch
---

Deleting a project (the `kind: "main"` row) now works from the TUI, and removing a project no longer leaves an orphan row behind. Pressing `d` on a project row used to route to `deleteTask`, which refuses main rows — so it just failed with a confusing error (e.g. `connect ENOENT …`). It now runs a non-destructive "forget project" flow: un-save the repo and drop its synthetic main row, while the repo's files, branches, worktrees, and any real tasks under it stay on disk. `kobe remove` got the same fix end-to-end — previously it dropped the saved-repos entry but left the main task in the daemon-owned index, so the project kept showing up. Both paths now go through a new `forgetProject` orchestrator method (and `project.forget` RPC), matching by the canonical git-toplevel key so a subdirectory or differently-realpathed input still hits the stored entry.
