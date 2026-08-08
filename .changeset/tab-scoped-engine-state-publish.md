---
"@sma1lboy/kobe": patch
---

A tab-scoped engine-state publish carries only that tab's session lineage. The task-level carry-forward used to ride along on tab-tagged publishes, so a session-less event on a fresh tab (codex hooks pipe no session id) inherited another tab's — even another engine's — session id and stamped it onto the new tab. Ported from the GUI chat-shell branch where the leak was diagnosed.
