---
"@sma1lboy/kobe": patch
---

Fix ctrl+h / ctrl+j pane focus on legacy terminals (macOS Terminal.app, #192): terminals without the kitty keyboard protocol send those chords as ambiguous C0 bytes (0x08 backspace / 0x0a linefeed), which never matched the focus bindings — they now alias back to their ctrl chords, while the real Backspace key (0x7f) keeps deleting. Also stop ctrl+h's left-edge tmux command from blocking the key queue (`run-shell -b`), so holding the chord can no longer freeze the client for seconds. `kobe doctor` now reports a terminal section (build/platform, TERM/TERM_PROGRAM, tmux nesting, live kitty-keyboard-protocol probe) and the bug-report issue template asks for its output.
