---
"@sma1lboy/kobe": patch
---

File pane Changes tab now shows +/- line counts for renamed files. The pane merges `git diff --numstat` counts onto each `git status` row by path, but the numstat parser looked for porcelain's ` -> ` rename separator — whereas `git diff --numstat` actually renders renames with ` => ` and brace-compacts the unchanged path segments (e.g. `src/{old.txt => new.txt}` or `{dir => other}/x.txt`). So a renamed file's stats keyed off the raw brace text, never matched its post-rename path, and the row rendered with blank counts. The parser now resolves the numstat field to the same canonical new path the porcelain `R` row reports, so renamed files carry their line counts like every other change.
