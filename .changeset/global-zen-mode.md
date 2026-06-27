---
"@sma1lboy/kobe": patch
---

Zen mode is now global across every project. Each task is its own tmux session, so toggling zen previously only collapsed the session you were in; switching to another project lost it. Zen on/off is now a persisted intent that every project's session reconciles to when you enter or attach it — turn it on once and all projects open focused.
