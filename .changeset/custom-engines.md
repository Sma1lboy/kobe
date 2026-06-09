---
"@sma1lboy/kobe": patch
---

**You can now add your own engine.** Settings → Engines gains a `+ Add engine` row: give it an id, a launch command (e.g. `aider --model sonnet`), and a display name, and it shows up in the new-task engine selector alongside Claude / Codex / Copilot. Picking it launches your command in the task pane. Custom engines are always offered (no binary probe — "you added it" counts), and `x` on a custom engine's row removes it (on a built-in, `x` still resets to default). Telemetry that needs a vendor-specific transcript format (auto-title, the activity badge, the cost dashboard) simply stays empty for a custom engine rather than mis-reading another engine's store — kobe drives the CLI, it just can't read a format it doesn't know. Under the hood the vendor id is now open: the daemon accepts any engine id, and a custom engine's command/name reuse the same per-engine state keys the built-ins use.
