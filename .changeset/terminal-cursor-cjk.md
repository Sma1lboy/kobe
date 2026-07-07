---
"@sma1lboy/kobe": patch
---

Fix the embedded-terminal cursor drifting away from the text when typing CJK / wide characters. Two causes: (1) the inline cursor cell counted code points instead of terminal cells, so every wide glyph before the cursor shifted it a column — now it walks by display width (shared `charWidth`/`displayWidth` moved to `lib/display-width.ts`); (2) the real host cursor was parked invisibly at (0,0), so the OS IME / pinyin candidate window had nothing to anchor to — it now tracks the embedded cursor's screen cell (still invisible; the inverse cell stays the visible cursor).
