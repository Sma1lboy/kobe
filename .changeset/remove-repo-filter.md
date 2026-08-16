---
"@sma1lboy/rove": patch
---

Remove the sidebar repo context filter (`ctrl+p`) shipped in #459: the chord shadowed in-terminal previous-history and the eventual session concept is a combination of repos, not a per-repo filter. Task-lifecycle changes from #459 (delete keeps the branch, archive→GC design) are untouched.
