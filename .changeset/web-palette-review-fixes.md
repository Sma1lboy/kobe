---
"@sma1lboy/kobe": patch
---

Polish from an adversarial review of the attention/conflict waves: the command palette no longer rebuilds its command list on every engine-state push while it's closed (the build is gated on open and the "needs you" set is snapshotted at open time), which also stops the head-of-list "Go to next task needing you" command from shifting the keyboard cursor when a task changes state mid-session. The conflict ⚠ badge now carries a `role="img"` + `aria-label` (e.g. "2 merge conflicts" / "1 file overlap") so screen readers convey the level and count instead of an unlabeled glyph.
