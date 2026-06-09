---
"@sma1lboy/kobe": patch
---

**The new-task engine selector now lists only the vendors you can actually run.** It used to always show claude / codex / copilot regardless of what was installed, so you could pick an engine whose CLI is missing. The dialog now renders only vendors whose CLI binary is detected on PATH (same probe the Settings → Accounts section uses; account login is not required — having the CLI installed is the only gate). `ctrl+e` cycles within the detected set and a persisted last-selected vendor that's no longer installed is clamped to a detected one. If nothing is detected (e.g. a PATH hiccup) the selector falls back to showing all vendors so task creation is never blocked.
