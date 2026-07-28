/**
 * Supervision verbs — the honest completion contract for agent-drives-agent
 * flows (`fan-out` and friends stay fire-and-forget without them):
 *
 *   - `report` — a WORKER files an explicit `succeeded`/`failed` verdict on
 *     its own task. Stored verbatim as the task's `workerReport` — worker
 *     report, not kobe-verified; kobe never infers an outcome from prose,
 *     exit codes, or silence.
 *   - `await` — a COORDINATOR blocks until every named task has a worker
 *     report (or the timeout fires), then gets all outcomes as one JSON
 *     object. Poll-free: it rides the daemon's `task.snapshot` push channel
 *     (a role-"pane" subscriber, so it never pins the daemon alive).
 *
 * A timeout is a CHECKPOINT, not a failure: silence never proves worker
 * death, so `await` resolves `{ timedOut: true }` with exit 0 and the
 * coordinator decides what to do (peek at the task, wait again, ask a
 * human). Deliberately minimal — no heartbeats, no mailboxes, no retries.
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { daemonOf } from "./handler-helpers.ts"
import { ApiError, type VerbContext, type VerbSpec } from "./types.ts"

/** Default `await` wait before returning a checkpoint (15 min). */
const DEFAULT_AWAIT_TIMEOUT_SECS = 900

export async function report(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const payload: Record<string, unknown> = { outcome: ctx.args.requireEnum<"succeeded" | "failed">("outcome") }
  const summary = ctx.args.str("summary")
  if (summary) payload.summary = summary
  // Workers usually run inside their task: engine tabs export KOBE_TASK_ID,
  // and any process in the worktree resolves via cwd on the daemon side.
  const taskId = ctx.args.str("task-id") ?? process.env.KOBE_TASK_ID
  if (taskId) payload.taskId = taskId
  else payload.cwd = process.cwd()
  return daemon.request("task.report", payload)
}

interface AwaitRow {
  readonly taskId: string
  /** True once this task has a worker report (or no longer exists). */
  readonly settled: boolean
  /** The worker's verdict; `null` while unsettled or when the task is missing. */
  readonly outcome: "succeeded" | "failed" | null
  readonly summary?: string
  readonly reportedAt?: string
  readonly status?: string
  /** The task id matched no task (typo, or deleted mid-wait) — settled, outcome unknowable. */
  readonly missing?: boolean
}

function evaluateRows(taskIds: readonly string[], tasks: readonly SerializedTask[]): AwaitRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return taskIds.map((taskId) => {
    const task = byId.get(taskId)
    if (!task) return { taskId, settled: true, outcome: null, missing: true }
    const report = task.workerReport
    if (!report) return { taskId, settled: false, outcome: null, status: task.status }
    return {
      taskId,
      settled: true,
      outcome: report.outcome,
      ...(report.summary ? { summary: report.summary } : {}),
      reportedAt: report.reportedAt,
      status: task.status,
    }
  })
}

export async function awaitTasks(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const taskIds = ctx.args
    .require("task-ids")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (taskIds.length === 0) throw new ApiError("await needs --task-ids id1,id2", "MISSING_TARGET")
  const timeoutMs = (ctx.args.int("timeout-secs") ?? DEFAULT_AWAIT_TIMEOUT_SECS) * 1000

  // Latest evaluation, kept so the timeout path reports what it last saw.
  let rows: AwaitRow[] = taskIds.map((taskId) => ({ taskId, settled: false, outcome: null }))
  const result = (timedOut: boolean) => ({
    timedOut,
    provenance: "worker report, not kobe-verified",
    tasks: rows,
  })

  return await new Promise((resolvePromise, rejectPromise) => {
    let done = false
    // Runs `fn` exactly once, after tearing down the listener + timer. `off`
    // and `timer` are declared below; every `settle` call site only executes
    // after both assignments (callbacks never fire synchronously here).
    const settle = (fn: () => void) => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      fn()
    }
    const check = (tasks: readonly SerializedTask[]) => {
      if (done) return
      rows = evaluateRows(taskIds, tasks)
      if (rows.every((r) => r.settled)) settle(() => resolvePromise(result(false)))
    }
    // Register the listener BEFORE subscribing: the bus replays the cached
    // task.snapshot on subscribe, so an already-settled set resolves without
    // waiting for a fresh mutation. The task.list read backstops a daemon
    // whose snapshot cache is cold.
    const off = daemon.onChannel("task.snapshot", ({ tasks }) => check(tasks))
    const timer = setTimeout(() => settle(() => resolvePromise(result(true))), timeoutMs)
    daemon
      .subscribe({ channels: ["task.snapshot"], role: "pane" })
      .then(() => daemon.request<{ tasks: SerializedTask[] }>("task.list"))
      .then(({ tasks }) => check(tasks))
      .catch((err) => settle(() => rejectPromise(err)))
  })
}

/** Spec half of the supervision verbs — spread into {@link VERBS} in `verbs.ts`. */
export const OUTCOME_VERBS: readonly VerbSpec[] = [
  {
    name: "report",
    summary:
      "Worker-side: file an EXPLICIT succeeded/failed outcome for a task. Stored verbatim as the task's workerReport (worker report, not kobe-verified). Task defaults to $KOBE_TASK_ID, then the cwd's worktree.",
    flags: [
      {
        name: "outcome",
        type: "enum",
        required: true,
        values: ["succeeded", "failed"],
        description: "The worker's explicit terminal verdict — never inferred by kobe.",
      },
      {
        name: "task-id",
        type: "string",
        placeholder: "ID",
        description: "Target task (default: $KOBE_TASK_ID, else resolved from the cwd's worktree).",
      },
      {
        name: "summary",
        type: "string",
        placeholder: "TEXT",
        description: "Optional one-line summary of what happened.",
      },
    ],
    handler: report,
  },
  {
    name: "await",
    summary:
      "Coordinator-side: block until every listed task has a workerReport (or the timeout fires), then return all outcomes as JSON. Poll-free (daemon push). A timeout is a checkpoint (exit 0, timedOut:true), not a failure.",
    flags: [
      {
        name: "task-ids",
        type: "csv",
        required: true,
        placeholder: "a,b,c",
        description: "Comma-separated task ids to wait on.",
      },
      {
        name: "timeout-secs",
        type: "int",
        default: String(DEFAULT_AWAIT_TIMEOUT_SECS),
        placeholder: "N",
        description: "Max seconds to wait before returning a timedOut checkpoint.",
      },
    ],
    handler: awaitTasks,
  },
]
