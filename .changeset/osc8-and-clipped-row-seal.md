---
"@sma1lboy/kobe": patch
---

Render OSC 8 hyperlinks in the fallback parser, and seal styled runs on clipped rows

Two follow-ups to the row-end attribute leak. The pipe-fallback ANSI parser
dropped OSC 8 hyperlinks outright, so a link rendered as plain text there while
`@xterm/headless` underlines it — the mock pane disagreed with the real pane
about what a link looks like. It now underlines a linked run to match. Separately,
the row-end seal only looked at a row's last chunk, so a row wider than the pane
(clipped at `cols`) still painted an attribute into the last visible column; it
now seals the last visible CELL, wide glyphs included.
