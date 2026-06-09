---
"@sma1lboy/kobe": patch
---

**`enter` in the file tree now opens the file directly in nvim/vim** — a changed file (vs HEAD) opens in side-by-side `nvim -d` diff mode with the committed version read-only on the left and the live editable file on the right; an unchanged file opens for plain editing. The HEAD blob is materialised to a tmp file (the `sh -c` safe stand-in for `<(git show …)`) and removed on exit, touching neither your nvim config nor the repo. When no nvim/vim is installed it falls back to the built-in read-only opentui preview, so `enter` is never a dead key. The separate `e` (edit) key is removed — `enter` is the single open action.
