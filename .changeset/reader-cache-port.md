---
"@sma1lboy/kobe": patch
---

Codex and Copilot history readers now share the append-aware transcript parse cache (previously Claude-only), so the ~2.5s history polls parse only newly appended lines and chat rows keep stable identity instead of re-rendering every tick.
