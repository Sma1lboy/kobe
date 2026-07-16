---
"@sma1lboy/kobe": patch
---

Engine session identity now flows end to end: hooks report their session_id/transcript_path, the daemon stores the latest-known id per task and per tab (carried forward across events that omit it), and `TaskEngineState` exposes it. Bare shell tabs (the ctrl+e "shell" pick) get the task/tab identity exported into the shell, so a user-typed `claude` reports tab-precise activity and its live sessionId — sessions kobe never spawned are no longer anonymous.
