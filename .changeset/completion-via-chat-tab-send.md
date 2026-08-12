---
"@sma1lboy/kobe": patch
---

Task completion now flows back through chat, not stored reports. A task created from inside another kobe task (`add`/`fan-out` run in an engine tab) gets a coda on its first prompt naming its spawner and the exact `kobe api send --task-id <spawner> …` command to message its outcome + final branch back — the spawner's chat tab is the completion channel, no coordinator discipline required. The `report`/`await` supervise verbs, the daemon's `task.report` RPC, and the persisted `workerReport` field are removed (nothing read them — outcomes silently vanished); `digest` keeps its window/repo task count and routine-run buckets but no longer claims succeeded/failed/unreported splits. Skill bumped to v15.
