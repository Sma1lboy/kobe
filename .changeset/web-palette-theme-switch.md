---
"@sma1lboy/kobe": patch
---

The web dashboard's command palette (Cmd/Ctrl+K) can now switch themes: every available theme shows up as a "Theme: <name>" command (the active one flagged), so you can fuzzy-search "theme" or a theme name and apply it without opening Settings. When a web-local override is active, a "Theme: Follow TUI" command clears it so the dashboard tracks the TUI's theme again (parity with the Settings picker). The web-local theme override persists as before (override > TUI ui-prefs > claude).
