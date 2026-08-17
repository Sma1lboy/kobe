---
"@sma1lboy/rove": patch
---

Sidebar move mode is scope-aware (issue #43): `shift+m` / `prefix+m` then `j`/`k` now moves the row under the cursor at its own level — a tab within its task, a task within its repo group, and a project-main row drags the whole project. All three levels stop at the edges (no wrap-around), the dragged row wears the move chip, and the new order persists across restarts (task/project order in tasks.json, tab order in the tab snapshot).
