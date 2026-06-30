---
"@sma1lboy/kobe": patch
---

feat: add a configurable worktree base directory (Settings → General → Worktree directory). New task worktrees are created under `~/.kobe/worktrees` by default; set an absolute path (`~` expansion supported) to keep them elsewhere — e.g. a faster disk or outside a backed-up home. The setting is stored in `state.json` and read by the daemon when it creates a worktree, so a change applies to the next task without a relaunch. Existing worktrees stay where they are, and the built-in default root remains recognized so older tasks stay discoverable after a base-path change. A non-absolute value is reflected in the row label and falls back to the default rather than blocking task creation.
