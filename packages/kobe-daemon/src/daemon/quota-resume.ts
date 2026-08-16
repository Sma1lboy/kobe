/**
 * Rate-limit auto-resume: when an engine reports `failure: "rate_limit"`, ask
 * the engine's quota probe when the exhausted window resets, persist that on
 * the task (`Task.quotaResume` — survives daemon restarts like
 * `Task.deletion`), and once the reset passes deliver a continue prompt into
 * the task's still-alive engine session.
 *
 * Boundaries:
 *  - Vendor knowledge (how to read the quota API) is engine-owned — this
 *    module only calls the runtime adapter's `quotaResetAtMs(vendor)`.
 *  - Delivery targets a LIVE session only. A dead engine is never respawned
 *    here: a fresh session has no context and would burn quota redoing work.
 *  - The runner must NOT be gated on `hasSubscribers` — resuming with nobody
 *    watching is the whole point.
 */

import type { DaemonOrchestrator, DaemonTask, EngineQuotaUsage } from "./contracts.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import type { QuotaUsageCache } from "./quota-usage-cache.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** Engine-neutral continuation instruction typed into the resumed session. */
export const QUOTA_RESUME_CONTINUE_PROMPT =
  "Continue the task from where it stopped. The transcript above shows the work already completed — do not redo it."

/** How often the runner scans for due resumes. */
export const DEFAULT_QUOTA_RESUME_TICK_MS = 60_000

/** Tasks whose armed schedule is due at `nowMs` and still deliverable. */
export function dueQuotaResumes(tasks: readonly DaemonTask[], nowMs: number): DaemonTask[] {
  return tasks.filter((task) => {
    if (!task.quotaResume || !task.worktreePath) return false
    if (task.deletion || task.archived) return false
    const at = Date.parse(task.quotaResume.resumeAt)
    return Number.isFinite(at) && at <= nowMs
  })
}

/**
 * The earliest future reset among EXHAUSTED windows, or null when nothing is
 * exhausted / no window carries a usable timestamp. Only exhausted windows
 * count: an allowed window's `resetsAt` is just rolling-window metadata, and
 * scheduling on it would resume long before the actual limit clears.
 */
export function exhaustedResetAtMs(usage: EngineQuotaUsage, nowMs: number): number | null {
  const candidates = usage.windows
    .filter((w) => w.percent >= 100 && w.resetsAt != null && w.resetsAt > nowMs)
    .map((w) => w.resetsAt as number)
  return candidates.length > 0 ? Math.min(...candidates) : null
}

/**
 * Read the vendor's usage (through the rate-limited cache — a rate-limit
 * event storm collapses onto one upstream fetch) and arm the task's resume
 * schedule. Called fire-and-forget from `engine.reportEvent` on a rate-limit
 * failure. No usable reset time arms nothing — the sticky `rate_limited`
 * badge keeps the task visible to the user, exactly as before this feature.
 */
export async function scheduleQuotaResume(
  orch: DaemonOrchestrator,
  runtime: DaemonRuntimeAdapter,
  cache: QuotaUsageCache,
  taskId: string,
  now: () => number = Date.now,
): Promise<void> {
  const task = orch.getTask(taskId)
  if (!task || !task.worktreePath || task.deletion) return

  // maxAge 0 = want the freshest view (the limit was JUST hit); the cache's
  // per-vendor fetch floor still bounds the upstream request rate.
  const usage = await cache.get(task.vendor ?? runtime.defaultTaskVendor, 0)
  const resetAtMs = usage ? exhaustedResetAtMs(usage, now()) : null
  if (resetAtMs == null) return

  // A reset already in the past still gets a schedule (the next sweep tick
  // delivers) — the engine said "limited", so an immediate manual retry would
  // just fail again a bit earlier than ours.
  await orch.setQuotaResume(taskId, {
    resumeAt: new Date(resetAtMs).toISOString(),
    requestedAt: new Date(now()).toISOString(),
  })
  logDaemonInfo("quota-resume", `armed task=${taskId} resumeAt=${new Date(resetAtMs).toISOString()}`)
}

/**
 * Deliver one due resume. The schedule is cleared BEFORE delivery so an
 * overlapping tick can never double-type the prompt; a failed delivery (no
 * alive engine session) is logged and dropped — if the engine later comes
 * back and hits the limit again, a fresh schedule is armed by the hook path.
 */
async function resumeDueTask(orch: DaemonOrchestrator, runtime: DaemonRuntimeAdapter, task: DaemonTask): Promise<void> {
  await orch.setQuotaResume(task.id, null)
  const delivered = await runtime.deliverPromptToLiveEngine(
    { id: task.id, vendor: task.vendor, command: task.command, worktreePath: task.worktreePath },
    QUOTA_RESUME_CONTINUE_PROMPT,
  )
  logDaemonInfo("quota-resume", `resume task=${task.id} delivered=${delivered}`)
}

/**
 * Start the due-resume sweep. Stateless per tick (reads the task index each
 * time), so daemon restarts need no re-arm pass — persisted schedules are
 * picked up by the first tick.
 */
export function startQuotaResumeRunner(
  orch: DaemonOrchestrator,
  runtime: DaemonRuntimeAdapter,
  tickMs: number = DEFAULT_QUOTA_RESUME_TICK_MS,
  now: () => number = Date.now,
): () => void {
  let sweeping = false
  const sweep = async (): Promise<void> => {
    if (sweeping) return
    sweeping = true
    try {
      for (const task of dueQuotaResumes(orch.listTasks(), now())) {
        await resumeDueTask(orch, runtime, task).catch((err) => logDaemonError("quota-resume", err))
      }
    } finally {
      sweeping = false
    }
  }
  const timer = setInterval(() => void sweep(), tickMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
