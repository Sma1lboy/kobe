---
"@sma1lboy/kobe": patch
---

Deleting the active task no longer flashes a window resize. The delete path switches the client to the next task (or kobe-home) before killing the old session, but unlike the normal switch/enter paths it skipped the pre-switch fit, so it landed on a session still sized to another client and reflowed. It now fits + heals the target first, matching `switchTo`/`jumpToTask`.
