---
"@sma1lboy/kobe": patch
---

Internal (web): the status-dot color and label are now derived together in one `activityMeta` switch (`src/lib/activity.ts`), so a new engine state can't get a color without a label; `activityColor` / `activityLabel` remain as thin accessors. The broader "unify activity + triage + notify into one engine-state meta" idea was declined and recorded as ADR 0002 — those three encode deliberately different policies (notably, `rate_limited` is a UI attention bucket but NOT a desktop-notification trigger, and triage also depends on worktree changes), so merging them would have regressed notifications. No behavior change.
