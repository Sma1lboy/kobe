---
"@sma1lboy/kobe": patch
---

Internal (web): the substring-search mechanic shared by the rail, board, and transcript filters now lives in one place (`textMatchesQuery` in `src/lib/text-match.ts`) instead of being re-implemented in `matchesTask`, `filterBoardCards`, and `messageMatchesQuery`. Each surface keeps its own field projection (what text gets searched) but delegates the trim/blank/case-insensitive rule, so it can't drift between search boxes. The rail search now also treats a whitespace-only query as "no filter" (it already did for the board and transcript) — a small consistency fix. The glob (`diff-filter`) and subsequence (`fuzzy`) matchers are intentionally left separate as different algorithms.
