---
"@sma1lboy/kobe": patch
---

Fix the web dashboard rendering a `�` replacement glyph when it truncates a path containing an emoji or a rare astral-plane character: the task rail and the diff file list tail-truncate long paths by keeping the filename end, but the shared `tailPath` helper sliced by UTF-16 code unit, so a cut that landed in the middle of a surrogate pair bisected the character. It now truncates by code point, so every glyph stays intact and a path already within budget by code-point count is no longer needlessly clipped.
