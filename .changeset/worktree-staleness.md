---
"@sma1lboy/kobe": patch
---

feat: the worktrees page judges each worktree with a staleness rubric — dirty tree > open PR > merged PR > 0-commits-ahead-of-main > closed PR > 14-day idle age, strongest signal first with git-only fallbacks when `gh`/GitHub is unavailable. Rows now carry a colored verdict badge (PR open / merged (PR) / in main / PR closed / stale) so it's obvious which worktrees are safe to clean; the badge is advisory and never gates deletion.
