---
"@sma1lboy/kobe": patch
---

refactor: split the over-cap orchestrator core + task-index store back under the file-size cap

`orchestrator/core.ts` and `orchestrator/index/store.ts` were only passing CI via file-size exemptions. Both are now under ~500 lines, behaviour-preserving and with an unchanged public interface: the store's pure lock-retry + on-disk codec moved to `index/store-codec.ts`; the orchestrator's git-worktree side-effects (allocate / materialise / adopt + their locks) moved to a `WorktreeCoordinator` collaborator, its in-place task-field edits to a `TaskEditor` collaborator, and its pure path/repo-key helpers to `core-helpers.ts`. The `Orchestrator` and `TaskIndexStore` classes keep every public method as a thin delegator, so no caller changed.
