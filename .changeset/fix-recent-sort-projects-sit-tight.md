---
"@sma1lboy/kobe": patch
---

Recent sort no longer reshuffles the projects (repo) rows. Selecting a project bumps its recency timestamp, so "recent" mode was reordering the project list under the user every time they opened one; now projects keep a stable order (alphabetical by repo in the TUI, incoming order in the web rail) in both sort modes, and only the worktree-task groups reorder by recent use.
