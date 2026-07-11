---
"@sma1lboy/kobe": patch
---

Internal architecture sweep across the pure-TUI layer: duplicated logic consolidated into shared modules (error-message formatting, latest-ref hook, task-action dialog adapters, sidebar row-card chrome and callback types, best-effort daemon connect), the TerminalTabs/workspace hosts split into focused hooks, and the embedded-terminal docs refreshed. No behavior change.
