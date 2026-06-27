---
"@sma1lboy/kobe": patch
---

fix: make the interrupted-prompt rescue writer append-only (no transcript clobber)

`appendInterruptedUserPrompt` ran during `engine.stop`, while the just-SIGTERM'd claude process may still be flushing buffered records to the same session JSONL. The merge path read the whole file into memory, spliced, and `writeFile`-rewrote it — truncating any record flushed after the read snapshot (a half-written assistant reply or tool result), silently losing data. It now only ever `appendFile`s: a coalesced un-replied user turn is written as a same-parent sibling that supersedes the prior turn (claude `--resume` follows the newest leaf, so the model still sees one user turn), and concurrent flushes are preserved no matter when they land.
