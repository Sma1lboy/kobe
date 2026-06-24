---
"@sma1lboy/kobe": patch
---

File pane no longer mangles non-ASCII filenames when the path is truncated on a narrow pane. `truncatePathTail` counted UTF-16 code units and sliced mid-character, so a path tail ending in an emoji or other astral character (e.g. `…my-🎉-feature.ts`) could split a surrogate pair and render a `�` replacement glyph. It now slices by code point — matching `orchestrator/title.ts` — so characters stay intact. The helper moved to the pure `filetree/rows.ts` module and gained unit tests.
