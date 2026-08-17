---
"@sma1lboy/rove": patch
---

Rove skill v29: "succeeded" means committed — a worker's green tests in an uncommitted working tree are not a deliverable, and the outcome report may only claim success once the work is committed on the branch. Closes the done-definition gap between workers (tests green) and `land` (commits exist) that produced silent empty merges.
