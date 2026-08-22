---
"@sma1lboy/rove": patch
---

Measure terminal cell width correctly when a value carries a stray control byte. A C0, DEL, or C1 control character (an escape byte, NUL, or similar) now counts as zero columns rather than one, so a task title or `rove export` cell that happens to include one no longer over-counts its width and shoves every column to its right out of alignment.
