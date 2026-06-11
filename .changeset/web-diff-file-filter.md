---
"@sma1lboy/kobe": patch
---

The web dashboard's Changes pane gains a file filter: when a worktree has more than one changed file, a search box above the file list narrows it by path (case-insensitive substring) — type `src/`, a filename, or an extension like `.tsx` to jump to the file you want in a large diff. The filter clears automatically when you switch tasks, and an empty result shows a "No files match" hint instead of a blank list.
