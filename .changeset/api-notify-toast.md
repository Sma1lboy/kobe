---
"@sma1lboy/kobe": patch
---

New `kobe api notify` verb: broadcast a toast to every attached kobe UI (`--title`, free-form `--kind` where `done`/`needs_input`/`error` carry the TUI's severity styling and anything else renders neutrally, optional `--task-id` for the sidebar unread mark, `--source` tag). Agents and scripts surface their own moments over the daemon's new `notice.event` channel without touching the task's session; the Workspace Host and the Tasks pane render it through the existing toast queue.
