---
"@sma1lboy/kobe": patch
---

Consolidate `git status --porcelain` / `git diff --numstat` parsing into one rigorous shared module (`src/lib/git-parsers.ts`) with correct C-string unquoting. The file-tree Changes tab and the sidebar's `+N −M` chip previously parsed the same two formats with different rigor and neither unquoted paths, so files whose names contain spaces, tabs, newlines, quotes, or non-ASCII bytes rendered with the wrong (still-escaped) path and renamed/modified spaced files silently lost their +/− line counts (porcelain quotes a spaced path, numstat does not, so the two never key-matched on join). Both panes now derive from the shared parser — preserving each one's IO contract (file tree throws, sidebar soft-fails to zero) — and the file-tree Changes tab now falls back to the staged diff on an initial commit / unborn branch so changed files still show real counts instead of blanks.
