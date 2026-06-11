---
"@sma1lboy/kobe": patch
---

Follow-ups from a second review pass: the bridge's engine-state mirror now prunes to the live task set on each task.snapshot (it previously grew forever — a deleted task's trailing idle frame and every lapsed-to-idle task accumulated, bloating the snapshot each fresh browser hydrates from), and the SPA reducer no longer re-inserts an orphan idle engine-state for a task that was just deleted. Both were self-healing in the UI; this keeps the bridge mirror and store bounded. (The pass also confirmed the prior review's 7 fixes introduced no regressions.)
