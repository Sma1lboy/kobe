---
"@sma1lboy/kobe": patch
---

Tasks can now carry an engine reasoning/effort level (e.g. Codex's `model_reasoning_effort`). The level is stored on the task, survives daemon restarts, and is applied to the engine launch line only when the task's engine actually supports it (Codex today) — any other engine, or an unknown level, is a no-op. Engines advertise their available effort levels through the engine registry, so the web UI never hard-codes the options.
