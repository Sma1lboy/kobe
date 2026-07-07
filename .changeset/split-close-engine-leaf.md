---
"@sma1lboy/kobe": patch
---

Fix closing the engine leaf in a split respawning Claude instead of keeping the surviving shell. The split now collapses back to the single-engine fast path only when the sole survivor is the engine leaf; a surviving shell keeps rendering as itself, and the tab label follows (it shows the shell's name, not the stale engine conversation title).
