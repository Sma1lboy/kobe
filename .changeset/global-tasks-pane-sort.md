---
"@sma1lboy/kobe": patch
---

Two Tasks-pane preferences — the sort toggle (`t`) and the `── keys ──` legend fold (`?`) — are now global instead of per-pane. Cycling the sort order, or collapsing/expanding the shortcut legend, used to change only the pane you pressed the key in; every other task session's Tasks pane kept its old order and fold state, so the rail looked inconsistent across sessions. Both now ride the same `ui-prefs` daemon channel as theme/appearance: the toggle persists to `state.json` and the daemon fans it out live, re-sorting and re-folding the Tasks pane of every open session at once. The choices also survive pane respawns and relaunches — a freshly spawned Tasks pane opens in your last sort and fold state rather than resetting. Panes running without a daemon still toggle locally and converge on reconnect.
