---
"@sma1lboy/kobe": patch
---

Reconnecting no longer lands on the wrong project, and stray daemons stop piling up. Selection restore now falls back to the persisted lastActive record and then the most recently updated task — never raw tasks.json array order (which led with the oldest saved repo and made every SSH reconnect open on it). Auto-spawned daemons get a session-scrubbed env plus an autospawn flag: one that never sees a GUI self-stops after a first-gui grace instead of living forever, and helpers running inside an engine session no longer kill-and-replace a busy shared daemon they mistook for wedged.
