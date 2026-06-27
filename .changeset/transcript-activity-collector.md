---
"@sma1lboy/kobe": patch
---

perf: daemon-collect transcript activity instead of polling it per Ops pane

Every `kobe ops` pane used to stat the engine transcript dir (the `● new` badge) and re-parse the newest session JSONL (the ChatTab "done" chip) on its own timers — W ChatTabs × K transcripts of duplicated filesystem churn at rest. The daemon now runs one `transcript.activity` collector for the shareable filesystem half (newest mtime + the engine-owned completion marker) and fans it out; the per-window `tmux capture-pane` quiescence check and `@kobe_tab_state` write stay in-process. Old/stale daemons without the channel fall back to the pane's local polling verbatim, and the badge/done-chip behavior is unchanged.
