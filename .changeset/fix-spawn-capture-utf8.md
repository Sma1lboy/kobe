---
"@sma1lboy/kobe": patch
---

Fix garbled non-ASCII output from the background git helpers on large repos: the shared capture helper decoded each stdout chunk on its own, so a multi-byte UTF-8 character split across a ~64 KB pipe boundary turned into replacement glyphs (`�`). The bytes are now joined before decoding, so a non-ASCII path (with `core.quotepath=false`) or any git output that carries raw UTF-8 comes through intact in the sidebar change chip, file counts, and PR prompt.
