---
"@sma1lboy/kobe": patch
---

Fix the `**` globstar in `kobe adopt --glob` and the New Task → Adopt filter so it matches zero intervening directories: a pattern like `src/**/task.ts` now matches `src/task.ts` (worktree directly under the prefix) as well as `src/a/task.ts`, and a leading `**/name` matches `name` at the root. Previously a segment globstar compiled to a form that required at least one directory between the slashes, so it silently hid the zero-directory case and dropped worktrees you expected to see.
