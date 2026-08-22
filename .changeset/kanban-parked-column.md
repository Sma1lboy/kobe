---
"@sma1lboy/rove": patch
---

Kanban gains a Parked column: `hold` (and unknown-status) stories now land in their own column between In progress and Done instead of masquerading as active work whenever they carry a task link. Parked accretes like Done, so it shares the same "+N more" cap; parked cards keep their live engine badge but never float or count toward "N need you" — a blocked engine is often exactly why the story was parked.
