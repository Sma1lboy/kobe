---
"@sma1lboy/kobe": patch
---

Add a "Start in zen mode" setting (Settings → General → Zen mode). Zen now remembers itself across restarts: the workspace seeds its layout from the persisted intent, and toggling zen with `prefix+z` writes that preference back. Focusing the file tree still drops out of zen for that session without clearing the setting.
