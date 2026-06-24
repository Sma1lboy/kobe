---
"@sma1lboy/kobe": patch
---

Full-window surface pages (new-task, settings, update, quick-task, help) no longer respond to the workspace navigation chords. Previously Ctrl+Q (back to tasks), Ctrl+[ / Ctrl+] (switch tab), and Ctrl+T / Ctrl+Shift+T (new tab) fired from the session-global tmux root table even while a surface page was open, yanking you out of a half-filled dialog. These windows now carry a `@kobe_surface` tag; the tab-switch chords no-op there and the new-chattab / back-to-tasks handlers return early. In-pane chords (Ctrl+hjkl) and prefix-gated ones were already harmless on a single-pane surface, and window management (close / rename) is left working.
