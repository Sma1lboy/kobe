---
"@sma1lboy/kobe": patch
---

feat: exiting a task's engine now tidies up its chat tab instead of leaving a dead shell. When the engine process exits and you then `exit` the fallback shell, kobe closes that chat tab — and if it was the task's only tab, it opens a fresh engine tab in its place so the task session never goes empty. The other workspace terminals (Ops / the bottom shell) are unchanged: exiting one of those just heals the layout. Together with the layout-heal and capture-poison fixes this resolves the "Exit the terminal layout error" report (#179).
