---
"@sma1lboy/kobe": patch
---

Own ellipsis truncation behind one code-point-safe module. Task titles, branch chips, and path tails previously each re-implemented their own slice-and-ellipsis logic with three different `max <= 0` behaviours and inconsistent surrogate-pair handling — the sidebar's path truncator could bisect an emoji into a `�`. They now all funnel through `truncateEnd` (keep prefix) / `truncateStart` (keep tail) in `tui/lib/truncate.ts`, so the boundary rule is one place and every label is surrogate-safe.
