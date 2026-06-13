---
"@sma1lboy/kobe": patch
---

Hardening from an adversarial review of the new Changes-pane glob filter: a pattern with several consecutive `*` (e.g. `**`, or `****` from key-autorepeat) no longer freezes the tab — runs of `*` are collapsed before building the match regex, removing the catastrophic-backtracking shape that the per-keystroke filter could hit. Negation now also works with surrounding whitespace (` !*.json`), and the transcript's per-message copy button reserves a gutter so it never paints over a turn timestamp and reveals on keyboard focus.
