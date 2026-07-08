---
"@sma1lboy/kobe": patch
---

Fix the React/OpenTUI workspace starting with a stale terminal size by resyncing the renderer against the controlling TTY before the first frame.
