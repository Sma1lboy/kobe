---
"@sma1lboy/kobe": patch
---

Pane-focus polish in the tmux handover: the directional focus chords (ctrl+h/j/k/l, or your `tmux.focus` overrides) no longer wrap at window edges — pressing ctrl+h on the leftmost Tasks pane is now a no-op instead of teleporting to the rightmost pane (each bind is gated on tmux's `pane_at_*` edge variables). And in the Tasks pane, the Right arrow jumps back into the current window's engine pane (`tasks.focusEngine` — user-overridable, F1-visible, shown in the keys legend), the natural inverse of ctrl+h.
