---
"@sma1lboy/kobe": patch
---

Six new plugin events: `task.landed`, `task.archived`, `issue.changed` (fired daemon-side), and `tab.opened` / `tab.closed` / `file.closed` (fired off the TUI tab-strip delta — mount-time restores don't announce). Catalog lives in the SDK contract; docs tables updated.
