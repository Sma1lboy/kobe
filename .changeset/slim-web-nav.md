---
"@sma1lboy/kobe": patch
---

The `kobe web` browser dashboard is slimmer and clearer. The top nav drops from three buttons to two — **Board** and **Issues** — and the standalone `/overview` mission-control route is gone; its triage now lives in the rail status chips and the Board's attention-filter chips, which share one `lib/triage.ts` engine instead of a separate Overview surface. Several little-used extras were removed along with it: the branch conflict radar, transcript copy-as-Markdown, the Task panel's Copy-link / share helper, PR-transition desktop notifications, the router devtools, and a few redundant Settings sections. To make the trimmed-down dashboard explain itself, the Board, Issues, transcript, diff, Settings, and Adopt surfaces now each render an offline/empty-state hint (for example "no tasks yet" or "daemon offline, reconnecting") instead of going blank when a daemon is down or a surface has nothing to show.
