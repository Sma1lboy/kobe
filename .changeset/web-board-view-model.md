---
"@sma1lboy/kobe": patch
---

Internal: the Board's derivation logic — flattening loaded issue state across repos, folding in the optimistic pending-link, deriving the project chips, applying the chip + text filter, and assembling the per-project columns — was ~40 lines of pure logic trapped inside the 780-line `Board` component, only exercisable by rendering it. It now lives behind one `buildBoardView(input) → view` function in `lib/board` (with `collectBoardIssues` / `deriveRepoChips` / `filterBoardCards` underneath), each unit-tested directly; the component just calls it in one memo and renders. No behavior change.
