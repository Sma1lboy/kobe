---
"@sma1lboy/kobe": patch
---

**Ctrl+Q is now two-stage: focus the Tasks pane first, detach second.** From the engine / Ops / shell pane, the first Ctrl+Q moves focus to the current window's Tasks pane instead of immediately dropping you back to the launching shell; pressing it again from the Tasks pane detaches as before. The check is the native `@kobe_role` pane tag (an `if-shell` in the tmux binding), so focusing Tasks costs no extra process. A one-step detach is still available via tmux's own `prefix d` / `ctrl+b d`.
