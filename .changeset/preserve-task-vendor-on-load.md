---
"@sma1lboy/kobe": patch
---

Fix tasks silently reverting to Claude on restart. The task index loader validated the persisted engine against a stale `claude | codex` check, so a Copilot task — or any task using a user-registered custom engine — quietly downgraded back to Claude every time the daemon reloaded `tasks.json`. Loading now preserves any recorded engine (built-in or custom) and only falls back to Claude when no engine was ever recorded, matching the documented vendor-coercion contract.
