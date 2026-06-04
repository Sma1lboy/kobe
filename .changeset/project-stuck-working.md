---
"@sma1lboy/kobe": patch
---

Fix a project row stuck showing the `working` chip when nothing is running. A `main` (project-root) task has no session lifecycle that maintains its status, so an old auto-done flip — revived by the `done → in_progress` self-heal on every load — left the project permanently `in_progress`, which the Tasks pane reads as "working". Project rows now ignore the persisted-status fallback (only a genuinely live engine handle makes a project read as working), and the on-load self-heal resets any `main` row to a neutral `backlog` instead of `in_progress`.
