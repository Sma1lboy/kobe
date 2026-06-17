---
"@sma1lboy/kobe": patch
---

Theme the full kobe tmux chrome instead of only pane borders. The dedicated `-L kobe` tmux server now derives the bottom status/window bar, status-left/right styles, command prompts, copy-mode selection, pane picker colors, and pane borders from the active kobe theme, so switching themes fully restyles the ChatTab bar without touching the user's real tmux server.

Make live theme propagation reliable when Settings writes the shared state file. The daemon now polls the tiny UI prefs file as a safety net for missed `fs.watch` tmp+rename events, so the selected-theme marker and already-running Tasks/Ops panes converge on the same theme as tmux chrome.
