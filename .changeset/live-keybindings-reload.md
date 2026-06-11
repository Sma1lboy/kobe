---
"@sma1lboy/kobe": patch
---

Editing `~/.kobe/settings/keybindings.yaml` now takes effect live across every session, instead of only on the next session rebuild. The daemon watches the keybindings file and pings a new `keybindings` channel on change; each open kobe pane re-reads the file and re-applies it onto its in-memory keymap from a clean slate (so a removed override correctly returns to its default, not the stale chord), and the Tasks-pane key legend re-renders to match. Binding behaviour updates without any extra nudge because the dispatcher already resolves chords on every keypress. Two boundaries are unchanged for now: the legend's built-in pane verbs (n/s/o/t/…) still display their default caps, and the tmux session-layer keys (`ctrl+t`, `ctrl+hjkl`, tab switching, detach) are bound on the tmux server at session build, so changing those still needs a rebuild to take effect. Panes running without a daemon keep their boot-time keybindings until relaunched.
