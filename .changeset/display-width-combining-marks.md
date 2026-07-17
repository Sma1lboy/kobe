---
"@sma1lboy/kobe": patch
---

Fix `kobe export --format=table` column alignment for decomposed Korean text and combining half marks: the shared cell-width measurer counted conjoining Hangul Jamo (the medial vowel + final consonant of a decomposed syllable, as macOS produces in NFD filenames) and the U+FE20–U+FE2F combining half marks as one cell each instead of zero, so a Korean filename measured up to twice its true width and shoved every later table column out of line. Both now fold to zero width, matching xterm's own wcwidth table (the embedded-terminal cursor path was already unaffected — it floors zero-width glyphs to one cell); the previously untested `display-width` module also gains its first test file.
