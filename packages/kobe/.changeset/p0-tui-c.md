---
"@sma1lboy/kobe": patch
---

TUI perf/correctness: share one live-title subscription store across the workspace terminal surfaces (fixes split-tab corner names bleeding across tabs and freezing after a leaf respawn), reclaim a deleted task's persisted `terminalTabs.*` snapshot plus sweep historical orphans, and stop the sidebar's 10Hz spinner timer + background git-status polling while the session is idle or detached.
