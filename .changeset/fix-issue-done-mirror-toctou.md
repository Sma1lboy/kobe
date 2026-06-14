---
"@sma1lboy/kobe": patch
---

Fix: a manually-reopened issue can no longer be silently snapped back to `done` by a racing task→done transition. The done-mirror previously read the issue store, then wrote it in a second, separate lock acquisition — a reopen landing in that window was clobbered by the stale decision. The reverse-lookup and the conditional flip now run atomically inside one `IssuesStore.mirrorTaskDone` lock.
