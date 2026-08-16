---
"@sma1lboy/rove": patch
---

Rove skill v26: document that managed worktrees are fresh checkouts — missing installs masquerade as test regressions, so agents must confirm the install step (`.rove/init.sh`, `rove repo set --init-script`, `rove repo show`) before reporting failures as real. Raised by a field report of three tasks misreading dependency-less failures as product bugs in one day.
