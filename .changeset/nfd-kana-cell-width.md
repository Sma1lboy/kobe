---
"@sma1lboy/kobe": patch
---

Fix cell-width measurement for NFD-decomposed Japanese kana and the CJK tone marks so a voiced-kana filename no longer drifts every later column out of alignment: the combining katakana-hiragana (semi-)voiced sound marks (U+3099/U+309A, which macOS splits off precomposed が/ぱ in NFD filenames) and the ideographic/Hangul tone marks (U+302A–U+302F) sat inside the wide Hiragana/CJK-symbols ranges and were each counted as one extra cell, so a decomposed kana measured up to twice its true width in the `kobe export` table and the embedded-terminal cursor overlay. They now fold to zero width like the already-handled Hangul jamo and combining half marks, matching xterm's own wcwidth table.
