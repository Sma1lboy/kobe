---
"@sma1lboy/rove": patch
---

Sidebar row labels get one derivation rule (issue #42): a task with a branch is named by it, a branchless dir/scratch task by its tail-truncated directory — `jacksonc-xxxx` auto-names are retired. Scratch tasks now mint no auto-name at all (title stays empty until you rename or adoption files them into a project); every title consumer (task channel, web board, kanban, `api list`/`get-task`, notifications) receives a wire-level fallback so an unnamed row never renders blank. Legacy auto-named scratch rows just render by the new rule — no data migration. ctrl+w on a scratch task's only tab now tears the whole task down (same zero-ceremony path as its shell exiting) instead of refusing with "Cannot close the only tab"; ordinary tasks keep the guard.
