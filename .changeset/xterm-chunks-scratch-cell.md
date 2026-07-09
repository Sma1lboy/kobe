---
"@sma1lboy/kobe": patch
---

perf: reuse one scratch cell in `xtermLineToChunks` instead of allocating per cell

`@xterm/headless`'s `line.getCell(x)` allocates a fresh cell object on every call, and the terminal render path called it for every cell of every converted line — the dominant per-cell allocation on that hot path. It now threads one shared scratch cell into `getCell(x, cell)` (xterm's documented reuse fast path), lazily seeded once program-wide, so line conversion allocates zero cells after warmup. Pure allocation change: the two-pass structure and the `minLast` cursor-tail invariant are untouched.
