---
"@sma1lboy/kobe": patch
---

Plugin/lifecycle UI surfaces: the sidebar now shows a "compacting context" word and a `◇N` subagent-activity mark on task rows (new low-frequency `engine.lifecycle` channel); Settings gains a Plugins section (installed list, enable/disable applied live via the daemon's registry watch, declared actions/events/panes, last hook run from the plugin log); the daemon keeps a per-task recent-engine-events ring buffer readable via the new `task.recentEvents` RPC.
