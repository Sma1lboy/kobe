---
"@sma1lboy/kobe": patch
---

The Tasks-pane sort toggle (`t`) is now a global preference instead of a per-pane one. Cycling between the default and most-recent orderings used to re-sort only the Tasks pane you pressed `t` in — every other task session's Tasks pane kept its old order, so the list looked inconsistent across sessions. Sort now rides the same `ui-prefs` daemon channel as theme/appearance: the toggle persists to `state.json` and the daemon fans it out live, re-sorting the Tasks pane of every open session at once. The choice also survives pane respawns and relaunches — a freshly spawned Tasks pane opens in your last sort rather than always resetting to default. Panes running without a daemon still toggle locally and converge on reconnect.
