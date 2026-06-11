---
"@sma1lboy/kobe": patch
---

The web Changes rail, file-preview tabs, and diff pane now refresh themselves while the agent works: they key off the daemon's `worktree.changes` counts (already streaming over SSE), so an edit in the worktree re-fetches the affected diff within a collector tick — no browser-side git polling, and the previous patch stays on screen during a refetch instead of flashing a loading state. Manual ↻ still works.
