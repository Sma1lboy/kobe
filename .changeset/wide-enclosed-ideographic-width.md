---
"@sma1lboy/kobe": patch
---

Fix cell-width measurement for Enclosed Ideographic Supplement glyphs (e.g. 🈚 🈯 🉐) and the 🀄/🃏 tile emoji so they count as two cells like other wide CJK/emoji characters — previously they under-counted as one cell, drifting every column to their right out of alignment in the `kobe export` table and the embedded-terminal cursor overlay.
