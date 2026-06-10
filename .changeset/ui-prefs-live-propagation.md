---
"@sma1lboy/kobe": patch
---

Appearance changes now propagate live to every open kobe pane across all task sessions. Switching the theme (or toggling transparent background / picking a focus accent) in Settings used to restyle only the session you changed it in — the Tasks and Ops panes of every other task session kept the old look forever, because each pane read the persisted prefs once at boot. The daemon now watches `state.json` and pushes visual-pref changes on a new `ui-prefs` channel; every pane host applies them immediately, including user-installed themes added after a pane started. This also fixes a smaller drift: the new-task, quick-task, update, and file-preview pages now honor transparent background and focus accent too, not just the theme. Panes running without a daemon keep their boot-time appearance until restarted; on reconnect the latest prefs are replayed automatically.
