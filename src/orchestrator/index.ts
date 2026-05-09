/**
 * Barrel for the orchestrator package.
 *
 * Wave 2 Stream E adds the `Orchestrator` class plus its typed errors;
 * the existing `index/` (TaskIndexStore) and `worktree/` (GitWorktreeManager)
 * sub-barrels remain the canonical entry points for those modules.
 *
 * Why this file exists at all: importing from `@orchestrator` (a single
 * path) is friendlier than `@orchestrator/core.ts` for downstream
 * consumers (the TUI and CLI). Tests reach into `core.ts` directly to
 * keep their failure messages pinpoint-able to a file.
 *
 * Note: TypeScript resolves `@orchestrator` to this file (the bare
 * `index.ts`) rather than to the `index/` subdirectory because file
 * resolution happens before directory resolution. The store sub-barrel
 * lives at `@orchestrator/index/...` and remains accessible.
 */

export {
  ConcurrencyCapError,
  CONCURRENCY_CAP,
  IllegalTransitionError,
  Orchestrator,
  PRPreconditionError,
  TaskNotFoundError,
} from "./core.ts"
export type { CreateTaskInput, OrchestratorDeps, Unsubscribe } from "./core.ts"
