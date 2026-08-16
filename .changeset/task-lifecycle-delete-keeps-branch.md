---
"@sma1lboy/rove": patch
---

Task delete now keeps the git branch by default — git is the durable record; pass `--delete-branch` on `rove api delete` to drop it too (`--force` never implies it). The sidebar gains a repo context filter on `ctrl+p` (pure view-layer, nothing persisted), and `docs/design/task-lifecycle.md` records the archive→internal-GC direction for issue #29.
