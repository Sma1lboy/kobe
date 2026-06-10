---
"@sma1lboy/kobe": patch
---

Theme-matched tmux pane borders. The separator lines between the Tasks / engine / Ops panes were drawn with whatever tmux had — stock defaults, or a user tmux.conf border like oh-my-tmux's `#303030` gray — which disappears against dark kobe themes, losing the visible pane boundaries and the only focus cue. kobe now sets `pane-border-style` from the active theme's `border` slot and `pane-active-border-style` from the focus-accent slot (the same color the in-pane focus indicators use) on its own `-L kobe` socket, so borders stay legible under every bundled or user theme and the active pane is highlighted in the theme accent. Applied on launch and session build, re-applied when you switch themes in Settings — no session rebuild needed — and your real tmux server is never touched. Opt out with `"tmuxBorderTheme": "off"` in kobe's `state.json`, which releases only the options kobe wrote.
