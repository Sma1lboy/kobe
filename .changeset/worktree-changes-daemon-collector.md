---
"@sma1lboy/kobe": patch
---

The sidebar's `+N −M` uncommitted-change chips are now fed by ONE `git status` collector in the daemon instead of every pane polling git itself (previously N panes × M tasks of duplicated background subprocesses). The daemon publishes the full counts map on a new additive `worktree.changes` channel — republished only when something actually changed, with the same guards that fixed the 30GB-repo freeze (in-flight dedupe per worktree, timeout + SIGKILL, hard backoff for timed-out repos, adaptive cadence, `GIT_OPTIONAL_LOCKS=0`). Archived tasks and remote (`ssh://`) projects are never collected, and deleted/archived tasks' entries drop from the map. Panes render the pushes and spawn zero git processes while daemon-connected; the local per-pane poller survives only as the fallback when no daemon is reachable or an older daemon doesn't advertise the channel in its hello capabilities.
