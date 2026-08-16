---
"@sma1lboy/rove": patch
---

Shell tabs now carry a live engine identity (issue #33 step 1): the sidebar probes every hosted session's process tree — not just tabs mounted in this TUI — so a hand-typed `claude`/`codex` in any shell tab lights an engine badge on its row, and dims when the engine exits (debounced against mid-restart flicker). `rove api get-task`'s per-tab `liveVendor` now reflects a fresh foreground walk for live tabs instead of the last TUI-recorded value.
