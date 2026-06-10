---
"@sma1lboy/kobe": patch
---

Fix the Tasks pane freezing on huge repos: the sidebar's per-row `+N −M` changes chip ran a synchronous `git status` for every row on every 2s tick, so a row pointing at a very large worktree (e.g. a 30GB repo, especially when listed in the Archives view) blocked the whole UI for the duration of each status walk. The chip now polls through an async background process with in-flight dedupe, a 4s timeout, and adaptive backoff (slow repos self-thin to at most one run per minute), and archived rows don't poll at all.
