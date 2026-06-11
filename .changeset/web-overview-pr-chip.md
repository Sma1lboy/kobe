---
"@sma1lboy/kobe": patch
---

Overview cards in the web dashboard now show the task's PR chip (number, lifecycle color, check-state hover) — the same signal the task rail already renders, so a failing or ready-to-merge PR is visible from the triage view too. The chip's precedence rules (terminal lifecycle beats check state) moved into a shared, unit-tested module used by both surfaces.
