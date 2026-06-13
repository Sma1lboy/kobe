---
"@sma1lboy/kobe": patch
---

The Changes pane's file filter now understands globs and exclusions, not just substrings: type `*.test.ts` to show only test files, `src/*` to scope to a directory, or `!*.json` to hide everything matching a pattern. A query with no `*` and no leading `!` keeps the old case-insensitive substring behavior, so nothing changes for plain text.
