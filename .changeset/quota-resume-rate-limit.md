---
"@sma1lboy/kobe": patch
---

Rate-limit auto-resume: when Claude Code hits its subscription quota, the daemon probes the account's usage API for the exhausted window's reset time, parks a durable `quotaResume` schedule on the task, and once the window resets automatically delivers a continue prompt into the task's still-live engine session. Vendor knowledge stays engine-owned (`quotaResetAtMs` on the engine registry entry); a probe that can't produce a reset time changes nothing — the sticky rate-limit badge keeps waiting for the user as before.
