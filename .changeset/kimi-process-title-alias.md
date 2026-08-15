---
"@sma1lboy/rove": patch
---

fix: live kimi sessions are recognized again by the foreground engine walk, so `send` into a running kimi tab and first-message paste delivery no longer refuse with `ENGINE_NOT_RUNNING` / `SESSION_FAILED`. Kimi's installed Mach-O binary rewrites its process title to `kimi-co` after launch, so the process-tree check never matched the launch binary name `kimi`; the engine registry now carries `processNames` aliases for exactly this case (claude/codex/copilot/custom engines are unchanged).
