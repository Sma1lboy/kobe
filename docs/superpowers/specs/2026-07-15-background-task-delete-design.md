# Background Task Deletion Design

## Goal

Make task deletion return control to the TUI immediately after safety checks,
while the daemon removes large worktrees in the background. A 10+ GB ignored
build tree must not leave the sidebar looking frozen, and a failed cleanup must
never create an invisible orphan worktree.

## Current behavior and root cause

`task.delete` currently waits for `KobeOrchestrator.deleteTask()`. That method
runs the dirty-worktree guard, `git worktree remove`, metadata prune, optional
branch deletion, and task-index removal before the RPC replies. The TUI cannot
move selection until that reply arrives. Ignored directories such as
`node_modules/`, Rust `target/`, replay capture homes, and video artifacts are
not reported by `git status --porcelain`, but `git worktree remove` still has to
delete every byte and directory entry.

## Considered approaches

### 1. Persist deletion state on the Task and run cleanup in the daemon

Recommended. Add an optional `Task.deletion` record and split deletion into a
short prepare step plus a background execute step. The task remains visible and
recoverable until physical cleanup succeeds. A new daemon process resumes
queued or interrupted deletions from `tasks.json`.

Trade-off: this crosses the task codec, daemon protocol, orchestrator, and row
view, but each boundary receives a small additive field and the failure model is
explicit.

### 2. Reuse only the in-memory `task.jobs` channel

The handler could fire-and-forget the existing synchronous delete and publish a
spinner event. This is smaller, but the event bus dies with the daemon. A
restart can leave an in-progress or partially completed deletion with no owner
and no visible state.

Rejected because deletion is destructive and must be recoverable.

### 3. Rename the worktree into a trash directory, then delete it

This can make the original path disappear quickly on one filesystem. It changes
Git worktree metadata semantics, can fail across volumes, and still needs a
durable cleanup queue.

Rejected as unnecessary scope and a weaker fit for `git worktree remove`.

## Data model

Add this optional additive field to `Task`, `DaemonTask`, and `SerializedTask`:

```ts
interface TaskDeletionState {
  phase: "queued" | "running" | "error"
  force: boolean
  requestedAt: string
  error?: string
}
```

The task-index version remains v3 because the field is optional and older v3
files remain valid. The v3 codec must preserve valid deletion records and drop
malformed ones.

- `queued`: safety checks passed and the request was durably accepted.
- `running`: the daemon runner started session teardown and filesystem cleanup.
- `error`: cleanup failed. The task and error remain visible; pressing delete
  again performs the normal confirmation and retries from `queued`.

## Deletion flow

1. The existing TUI confirmation calls `task.delete` as today.
2. The daemon calls `prepareTaskDeletion(taskId, { force })`.
3. Prepare rejects main tasks and performs the current dirty-worktree check.
   A dirty non-force request still returns `DIRTY_WORKTREE`, so the existing
   explicit force-delete confirmation remains unchanged.
4. Prepare persists `deletion.phase = "queued"` before replying.
5. The daemon starts one deduplicated background runner for the task and returns
   the RPC response immediately. Repeated requests while queued/running do not
   start a second runner.
6. The TUI moves selection and releases its local tab snapshot using its
   existing post-delete flow. Other clients see the task row change to
   `deleting` through the authoritative `task.snapshot`.
7. The runner persists `running`, stops the task's Hosted PTY sessions through
   the existing neutral runtime adapter, then removes the worktree, prunes Git
   metadata, and performs the existing best-effort branch cleanup.
8. On success, the task is removed from the index. On failure, the runner
   persists `error` and the message instead of removing the task.

The runner scans `listTasks()` when a daemon starts and resumes both `queued`
and `running` records. It does not auto-retry `error` records.

## Interaction guards

A task with any `deletion` state is not activatable. Worktree materialization
and Hosted PTY session/spec creation must reject it with a stable
`TASK_DELETING` message. This prevents another client from recreating a session
inside a directory that the background runner is deleting.

The task stays in snapshots until success. It is not archived and is not hidden
from the index, so cleanup errors remain discoverable and retryable.

## UI behavior

- `queued` and `running` rows use the existing spinner infrastructure with the
  subtitle `deleting` / `正在删除`.
- `error` is non-animated, uses the error tone, and shows
  `delete failed` / `删除失败`.
- No percentage is shown because `git worktree remove` exposes no reliable
  progress metric.
- The existing dirty and force-confirm dialogs are unchanged.

## Compatibility

`task.delete` keeps its request name and payload. Its success meaning changes
from "physical cleanup completed" to "background deletion durably accepted".
The CLI, TUI, and web clients therefore remain wire-compatible. Existing
post-RPC Hosted PTY teardown calls remain safe because teardown is idempotent;
the daemon runner becomes the authoritative cleanup owner.

## Tests

- Codec tests preserve valid deletion state and drop malformed state.
- Orchestrator tests pin prepare safety, durable queued/running/error
  transitions, successful removal, failed cleanup retention, and activation
  guards.
- Daemon handler tests prove `task.delete` returns before a blocked physical
  cleanup finishes and deduplicates repeated requests.
- Daemon runner tests prove startup resume, Hosted PTY teardown ordering, error
  persistence, and no auto-retry of terminal errors.
- Sidebar row tests pin deleting spinner and delete-failed rendering.
- Existing dirty-worktree, force-delete, task snapshot, CLI, web, and behavior
  tests remain green.

## Scope boundaries

This change does not make filesystem deletion faster, calculate byte progress,
move worktrees to a trash directory, add cancellation, or change archive
semantics. It only makes task deletion responsive, durable, observable, and
retryable.
