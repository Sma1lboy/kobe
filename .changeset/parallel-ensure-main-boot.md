---
"@sma1lboy/kobe": patch
---

Boot now issues every saved repo's main-task ensure concurrently instead of one serial daemon round-trip after another.

`ensureRepos` looped `await orchestrator.ensureMainTask(repo)` per repo, so with N saved repos the pre-first-paint boot paid N latency-bound round-trips back to back. The daemon transport already pipelines id-correlated requests and the store's saveChain/file-lock serialize the writes, so the calls now go out together via `Promise.all` — collapsing N RTTs into ~1 wall time. Per-repo error isolation is unchanged: a failing repo is caught and logged, and no longer blocks (or rejects) the others.
