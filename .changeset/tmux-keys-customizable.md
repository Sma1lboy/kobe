---
"@sma1lboy/kobe": patch
---

tmux-layer session keys are now customizable from the same `~/.kobe/settings/keybindings.yaml`: `tmux.tab.new` (ctrl+t), `tmux.tab.prev`/`tmux.tab.next` (ctrl+[ / ctrl+]), `tmux.tab.close` (ctrl+w), `tmux.tab.rename` (f2), `tmux.tab.chooseEngine` (ctrl+shift+t), `tmux.detach` (ctrl+q), and `tmux.focus` (a positional 4-chord group, left/down/up/right, default ctrl+h/j/k/l). Overridden defaults are unbound on the kobe tmux server so old chords don't linger; `null` skips installing a binding. Guard rails reject `cmd+` chords (never reach tmux) and bare keys that would shadow typing in the engine/shell panes. The Tasks-pane footer legend, the tmux status-right hint, and the Settings → Keybindings report all render the resolved chords. Overrides apply when a session is (re)built.
