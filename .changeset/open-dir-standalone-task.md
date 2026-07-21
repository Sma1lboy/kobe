---
"@sma1lboy/kobe": patch
---

`kobe .` (or `kobe <path>`) opens a directory as a standalone task — no project association, no worktree or branch created. The new `kind:"dir"` task pins the directory itself, can be archived like any task, and deleting it only removes the task entry: the directory on disk is never touched. Opening the same directory again creates another independent task (parallel sessions in one directory); titles get a short random suffix to keep the rows distinguishable.
