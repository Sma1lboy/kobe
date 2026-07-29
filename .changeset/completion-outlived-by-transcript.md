---
"@sma1lboy/kobe": patch
---

A task no longer reads as done while its engine is still working: `turn-complete` fires when the main agent's reply ends, but a long tool call or background subagent then runs on in total hook silence (measured: nine minutes of it), so the sidebar showed a ✓ over a working engine. A completion whose transcript kept growing after it is now treated as still running — self-correcting, since the final hook fires after the last transcript write.
