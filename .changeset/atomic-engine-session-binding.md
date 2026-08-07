---
"@sma1lboy/kobe": patch
---

Keep Agent Trace aligned with the process visible in its chat tab. A newly
spawned engine with no native session id renders an empty trace instead of the
previous conversation, then binds in place when the id arrives; daemon startup
also converts abandoned pending runs to this stable empty state. Codex engine
processes are now watched continuously by the daemon, so native `/resume`
switches no longer depend on a terminal Enter notification. Agent Trace uses
one shared session snapshot stream, eliminating the competing history-fetch
race that could leave a resumed run empty.
