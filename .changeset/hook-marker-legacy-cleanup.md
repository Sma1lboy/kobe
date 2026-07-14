---
"@sma1lboy/kobe": patch
---

Fix duplicate global engine hooks after upgrade: the activity-hook merge now recognizes legacy unquoted `kobe hook <verb>` entries as kobe's own and replaces them, instead of leaving them behind next to the quoted form — previously every Claude event fired kobe's hook twice (double `kobe hook` spawns and duplicate daemon reports). The stale entries are cleaned automatically on the next kobe launch.
