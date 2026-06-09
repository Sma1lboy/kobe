---
"@sma1lboy/kobe": patch
---

**Project (repo) rows in the sidebar are now two-line cards, like tasks.** A project used to be a single line — `★ repo   ~/path` — while tasks were two-line cards, so the two read differently. A project now shows `★ repo` on line 1 and the repo root's **current branch** plus the `+N −M` uncommitted-change chip on line 2, exactly like a task. So at a glance you see which branch each repo root is on and whether it's dirty; the repo path moved to the hover tooltip (where task paths already live).
