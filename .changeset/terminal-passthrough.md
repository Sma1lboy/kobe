---
"@sma1lboy/kobe": patch
---

Embedded terminal input + chrome fixes (issue #16): the pane no longer draws its own border (the workspace layout wrapper owns the focus border — double borders gone), and key passthrough is now maximal — shift+tab (claude's plan-mode cycle), ctrl+hjkl, F1, ctrl+p and every other modifier combo reach the engine CLI. Kobe reserves only ctrl+q (escape hatch), the tab-management chords, and F5 while the terminal is focused; its other global chords stay reachable from every non-terminal pane.
