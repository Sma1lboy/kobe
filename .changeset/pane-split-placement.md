---
"@sma1lboy/kobe": patch
---

Plugin panes now default to `placement = "split"`: the pane joins the focused chattab's split group beside the engine (the herdr-style split semantics), instead of opening a separate tab. `placement = "tab"` in the manifest keeps the old behavior; content-tab/depth-cap cases fall back to a tab automatically.
