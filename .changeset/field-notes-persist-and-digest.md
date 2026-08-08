---
"@sma1lboy/kobe": patch
---

Field notes now persist and seed the next session, and `kobe api digest` measures the fleet.

Field notes used to evaporate with the dispatcher's transcript, so a gotcha resolved on Monday was invisible to Tuesday's worktree. `kobe api note` now appends to a durable per-repo store (newest 50, keyed by git common-dir) and every fresh worktree session is launched knowing the newest 15 — presented as prior claims with provenance, not instructions. `kobe api note-list --repo PATH` reads them back.

`kobe api digest --repo PATH [--since-days N]` aggregates worker-reported task outcomes and routine run statuses over a window. It reads state kobe already persisted and had no reader for, so a change to how the fleet works now has a number it has to move.
