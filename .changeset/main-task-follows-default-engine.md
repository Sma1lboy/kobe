---
"@sma1lboy/kobe": patch
---

A project's main chat now follows your configured default engine instead of always opening on Claude. The main task's engine was frozen to "claude" the moment the project was first added and never re-read the default, so setting the default to codex had no effect on existing projects. Worse, on a daemon restart the stale "claude" vendor would win the vendor-drift check and respawn a healthy running codex session back to Claude, wiping the open chat tabs. The launcher now reconciles before starting the session: it adopts the vendor a live session is actually running (so a restart never clobbers it), and falls back to the global default when no session is up (so cold-opening an existing project honors the default). Newly added projects also create their main task on the default engine.
