---
"@sma1lboy/kobe": patch
---

Fan-out grows up: a mid-loop `task.create` failure no longer orphans the already-created siblings — every failure path now reports through `PARTIAL_FANOUT` (stdout + exit 3) with the created taskIds, and the dispatcher contract is pinned by tests. Each fan-out round stamps a shared `groupId` on its tasks (persisted, on the wire, and in `collect` output) and sibling titles get a `#i/N` ordinal — explicit `--title`s at create time, prompt-derived names via the auto-title pass — so five attempts at one prompt no longer converge on identical sidebar rows. `collect` adds a committed-work view per task: `base.ahead` (commits over the base branch) and `base.diff` (files/+/− vs the merge-base), so picking a winner no longer reads `+0 −0` the moment an attempt commits. The kobe agent skill (v5) now teaches the round's closing moves: `land` the winner (`--then-archive`), archive the losers.
