---
"@sma1lboy/kobe": patch
---

Fix the embedded terminal's block cursor rendering in the wrong column when the engine CLI parks the cursor to the right of the last visible glyph on its line. The per-row snapshot builder passes `cursorX - 1` as a floor so the cursor's row materializes out to at least the cursor column, but the visible-cell scan overwrote that floor with a plain assignment instead of taking the max — so on any row whose content ends before the cursor (trailing whitespace, a cleared-to-end-of-line prompt, a right-aligned status, a completion menu) the row collapsed to the last glyph and the cursor overlay snapped left onto it. The scan now keeps the floor, so the cursor lands at its true column; the previously untested `xterm-chunks` row builder gains a unit test pinning the floor behavior.
