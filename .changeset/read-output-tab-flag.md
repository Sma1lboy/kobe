---
"@sma1lboy/rove": patch
---

fix: `rove api read-output` learns `--tab tab-N` — every API verb's smallest unit is one terminal tab, but read-output could only resolve the task's canonical engine tab, making a sibling tab's screen (e.g. the one actually running the engine after a `--tab new` respawn) unreadable headlessly. A tab read is terminal-only (history is worktree-scoped), refuses `--source history` with a typed `BAD_FLAG`, answers a missing tab with `TAB_NOT_FOUND`, and the cursor now pins the tab alongside the pid so paged reads can't silently hop tabs.
