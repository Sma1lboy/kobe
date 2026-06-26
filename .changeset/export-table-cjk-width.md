---
"@sma1lboy/kobe": patch
---

`kobe export --format table` now aligns its columns by terminal display width instead of UTF-16 code-unit length, so a wide-glyph cell no longer shoves every column to its right out of line. A CJK task title (the common case — kobe is Simplified-Chinese-default), a fullwidth or emoji character all count as two cells, combining marks and variation selectors as zero, and astral characters (CJK Extension B, emoji) count once rather than as their two surrogate units; the table stays aligned for any mix of scripts.
