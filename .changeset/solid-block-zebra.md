---
"@sma1lboy/kobe": patch
---

Half-block renderers (the carbonyl browser plugin, the video player) no longer show grey "zebra stripes" in embedded panes: solid-block glyphs (▀▄█) whose foreground equals their background now render as background-only spaces — visually identical pixels, but the HOST terminal's minimum-contrast feature (iTerm) can no longer darken the glyph half of same-color cells.
