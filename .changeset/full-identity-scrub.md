---
"@sma1lboy/kobe": patch
---

Embedded terminals now scrub the outer emulator's entire identity namespace (LC_TERMINAL, ITERM_*, TERM_SESSION_ID, KITTY_*, GHOSTTY_*, WEZTERM_*, ALACRITTY_*, KONSOLE_*, VTE_VERSION, WT_*, TMUX, ZELLIJ, screen markers, __CFBundleIdentifier), not just TERM_PROGRAM. Apps with layered terminal detection (claude-code) no longer fall back to the outer emulator's dialect, which kept causing redraw artifacts inside kobe panes.
