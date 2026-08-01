/**
 * Automation sweep: fire due schedules, one fresh task per run.
 *
 * Shape copied wholesale from {@link startQuotaResumeRunner} — same stateless
 * tick, same re-entrancy latch, same unref'd timer, and the same deliberate
 * exemption from the `hasSubscribers` gate that every other collector honours:
 *
 *   Running with nobody attached is the entire point of a schedule.
 *
 * Restart behaviour falls out of the data model rather than any code here.
 * `Automation.nextRunAt` is an absolute timestamp on disk, so a daemon that
 * restarts (or was down for a day) re-discovers every armed schedule on its
 * first tick — there is no re-arm pass, and deliberately so.
 *
 * What the daemon being DOWN costs is a different question, and the one this
 * module actually has to answer: an occurrence that came and went unobserved.
 * That is `missedRunGraceMinutes` — run it late if it is still recent enough
 * to be useful, otherwise record `skipped_missed` and move on. Only the most
 * recent missed occurrence is ever considered; a week offline must not
 * stampede seven runs at boot.
 */

import type { DaemonRpcClient } from "../client/rpc.ts"
import { formatPrecheckSkip, precheckPassed, runAutomationPrecheck } from "./automation-precheck.ts"
import type { AutomationsStore } from "./automations-store.ts"
import type { Automation, AutomationRunStatus, DaemonOrchestrator } from "./contracts.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import { latestCronAtOrBefore } from "./cron.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** How often the sweep looks for due schedules. Cron's own resolution is one
 *  minute, so a faster tick would only re-ask the same question. */
export const DEFAULT_AUTOMATION_TICK_MS = 60_000

/** Automations whose armed time has arrived. */
export function dueAutomations(automations: readonly Automation[], nowMs: number): Automation[] {
  return automations.filter((a) => {
    if (!a.enabled) return false
    const at = Date.parse(a.nextRunAt)
    return Number.isFinite(at) && at <= nowMs
  })
}

/**
 * Which occurrence this firing is for, and whether it is still worth running.
 *
 * Split out as a pure function because it is the whole missed-run policy and
 * deserves to be tested without a clock or a filesystem. `notBefore` is the
 * automation's creation time so a brand-new schedule cannot claim occurrences
 * that predate it.
 */
export function resolveDueOccurrence(
  automation: Automation,
  nowMs: number,
): { scheduledFor: number; missed: boolean } | null {
  const notBefore = Date.parse(automation.createdAt)
  const scheduledFor = latestCronAtOrBefore(automation.schedule, nowMs, Number.isFinite(notBefore) ? notBefore : 0)
  // No occurrence at or before now means `nextRunAt` is stale relative to the
  // current expression (a hand-edited file, or an edit that lost a race). The
  // caller just re-anchors the schedule.
  if (scheduledFor === null) return null
  const graceMs = automation.missedRunGraceMinutes * 60_000
  return { scheduledFor, missed: nowMs - scheduledFor > graceMs }
}

/** The slice of the orchestrator this runner needs. */
export type AutomationOrchestrator = Pick<DaemonOrchestrator, "createTask">

export type AutomationRuntime = Pick<DaemonRuntimeAdapter, "startTaskSessionWithPrompt">

interface RunnerDeps {
  readonly store: AutomationsStore
  readonly orch: AutomationOrchestrator
  readonly runtime: AutomationRuntime
  /** The daemon's in-process RPC client, or a getter for it — the server's
   *  self-link is constructed after the collectors start, and the sweep only
   *  needs it on a tick. */
  readonly link: DaemonRpcClient | (() => DaemonRpcClient)
  readonly now?: () => number
}

function resolveLink(link: RunnerDeps["link"]): DaemonRpcClient {
  return typeof link === "function" ? link() : link
}

/**
 * Execute one automation now, recording exactly one run. Exported for
 * `automation.runNow` (manual trigger), which skips the precheck: the user
 * asking for it IS the answer to "is this worth running".
 */
export async function runAutomationOnce(
  deps: RunnerDeps,
  automation: Automation,
  args: { scheduledFor: number; trigger: "scheduled" | "manual" },
): Promise<AutomationRunStatus> {
  const now = deps.now ?? Date.now
  const record = async (
    status: AutomationRunStatus,
    extra: { taskId?: string; error?: string; precheckResult?: Awaited<ReturnType<typeof runAutomationPrecheck>> } = {},
  ): Promise<AutomationRunStatus> => {
    await deps.store.recordRun({
      automationId: automation.id,
      scheduledFor: new Date(args.scheduledFor).toISOString(),
      status,
      trigger: args.trigger,
      at: new Date(now()).toISOString(),
      ...extra,
    })
    return status
  }

  if (args.trigger === "scheduled" && automation.precheck) {
    const result = await runAutomationPrecheck(automation.precheck, automation.repo)
    if (!precheckPassed(result)) {
      logDaemonInfo("automation", `skip ${automation.name}: ${formatPrecheckSkip(result)}`)
      return await record("skipped_precheck", { precheckResult: result, error: formatPrecheckSkip(result) })
    }
  }

  let taskId: string
  try {
    const task = await deps.orch.createTask({
      repo: automation.repo,
      title: automation.name,
      ...(automation.vendor ? { vendor: automation.vendor } : {}),
      ...(automation.baseRef ? { baseRef: automation.baseRef } : {}),
    })
    taskId = task.id
  } catch (err) {
    // A repo that moved or was forgotten lands here — the schedule is fine,
    // its target is not, so this is `unavailable` rather than a failure.
    const error = err instanceof Error ? err.message : String(err)
    logDaemonError("automation-create-task", err)
    return await record("skipped_unavailable", { error })
  }

  try {
    const started = await deps.runtime.startTaskSessionWithPrompt(resolveLink(deps.link), taskId, automation.prompt)
    if (!started) {
      // The task EXISTS even though its engine did not start, so the id is
      // carried on the run record — the user can open it and retry by hand.
      return await record("dispatch_failed", { taskId, error: "engine session did not start" })
    }
    logDaemonInfo("automation", `dispatched ${automation.name} task=${taskId}`)
    return await record("dispatched", { taskId })
  } catch (err) {
    logDaemonError("automation-dispatch", err)
    return await record("dispatch_failed", { taskId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** One sweep pass. Exported so tests can drive it without a timer. */
export async function sweepAutomations(deps: RunnerDeps): Promise<void> {
  const now = deps.now ?? Date.now
  for (const automation of dueAutomations(deps.store.list(), now())) {
    const nowMs = now()
    const occurrence = resolveDueOccurrence(automation, nowMs)
    if (!occurrence) {
      await deps.store.advanceNextRun(automation.id, nowMs)
      continue
    }

    // Advance BEFORE doing any work: an overlapping sweep (or a slow engine
    // spawn) must never see this occurrence as still due and fire it twice.
    await deps.store.advanceNextRun(automation.id, occurrence.scheduledFor)

    if (occurrence.missed) {
      await deps.store.recordRun({
        automationId: automation.id,
        scheduledFor: new Date(occurrence.scheduledFor).toISOString(),
        status: "skipped_missed",
        trigger: "scheduled",
        at: new Date(nowMs).toISOString(),
        error: `missed by more than the ${automation.missedRunGraceMinutes}m grace window`,
      })
      continue
    }

    await runAutomationOnce(deps, automation, {
      scheduledFor: occurrence.scheduledFor,
      trigger: "scheduled",
    }).catch((err) => logDaemonError("automation-run", err))
  }
}

/**
 * Start the sweep. `tickMs: 0` disables it entirely — the test harness boots a
 * daemon with every collector zeroed, and this must honour that too.
 */
export function startAutomationRunner(deps: RunnerDeps, tickMs: number = DEFAULT_AUTOMATION_TICK_MS): () => void {
  if (tickMs <= 0) return () => {}
  let sweeping = false
  const tick = async (): Promise<void> => {
    if (sweeping) return
    sweeping = true
    try {
      await sweepAutomations(deps)
    } finally {
      sweeping = false
    }
  }
  const timer = setInterval(() => void tick().catch((err) => logDaemonError("automation-sweep", err)), tickMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
