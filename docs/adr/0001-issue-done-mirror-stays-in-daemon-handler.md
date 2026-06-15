# ADR 0001 — The issue done-mirror stays in the daemon handler, not the Orchestrator

- Status: accepted
- Date: 2026-06-14

## Context

When a **Task** transitions to `done`, the daemon mirrors that onto the Task's
linked **Issue** (flip the issue to `done` too, so a unified board stays
consistent). Today this side effect lives in the `task.status` RPC handler
(`packages/kobe-daemon/src/daemon/handlers.ts`), which calls
`Orchestrator.setStatus` and then `IssuesStore.mirrorTaskDone` + `bus.publish`.

An architecture review suggested "deepening" this by moving the mirror *into*
`Orchestrator.setStatus`, on the locality argument that any path reaching `done`
should mirror — not just this one RPC.

## Decision

Keep the done-mirror in the daemon `task.status` handler. Do **not** move it into
`Orchestrator.setStatus`.

Two reasons:

1. **There is no second path to `done`.** `Orchestrator.setStatus` has exactly
   two callers: the `task.status` handler, and the auto-status rule
   (`monitor/status-rules.ts`). Auto-status only ever does
   `backlog → in_progress` — it deliberately never auto-dones (see "the auto-done
   incident" guardrail in that file). So the handler is already the single
   entry point for every `done` transition; the locality gap the suggestion
   solves does not exist.

2. **It would break a documented boundary.** The **Orchestrator** is the `kobe`
   package's "task index + git + a Solid signal, TUI-free" core
   (`CONTEXT.md`). The **IssuesStore** and the daemon event **bus** are
   `kobe-daemon`-owned. Injecting them into the Orchestrator would create a
   `kobe → kobe-daemon` dependency and reintroduce side-effect coupling the v0.6
   reshape deliberately removed.

The single source of truth for the valid status set now lives in
`TASK_STATUSES` / `isTaskStatus` (`types/task.ts`), replacing the handler's
inline `!==` chain — that part of the deepening was kept.

## Consequences

- The mirror coordination is correctly located at the daemon's one status-change
  entry point; `IssuesStore.mirrorTaskDone` keeps the read-and-flip atomic.
- If a future change adds a *second* path that can move a task to `done` outside
  the `task.status` handler, revisit this: the right home would be a daemon-side
  status coordinator that both paths call — still not the Orchestrator.
