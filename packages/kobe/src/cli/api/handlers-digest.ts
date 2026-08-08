/**
 * `digest` — the RULER. An aggregate read over state kobe already persists:
 * worker reports (`task.workerReport`) and routine run outcomes
 * (`AutomationRun.status`). No new data model, no new writer — those two
 * records were already on disk and simply had no reader.
 *
 * Why it exists: kobe runs a lot of unattended agent work (fan-out, routines,
 * the dispatcher) and had no way to answer "is this week better than last
 * week". Every self-improvement mechanism is astrology without a measurement
 * it can move, so the ruler ships before anything that claims to learn.
 *
 * It reports what workers CLAIMED, never what kobe verified — the same
 * provenance rule `report`/`await` hold. A `succeeded` count is a count of
 * self-declared successes; treat a rising `unreported` share as the honest
 * signal that the fleet is drifting out of the supervision contract.
 */

import type { Automation, AutomationRun, AutomationRunStatus } from "@sma1lboy/kobe-daemon/daemon/contracts"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { daemonOf } from "./handler-helpers.ts"
import type { VerbContext, VerbSpec } from "./types.ts"

/** Default look-back for a digest, in days. */
const DEFAULT_SINCE_DAYS = 7

/** Cap on the named-failure list so a bad week can't produce an unreadable wall. */
const FAILURE_SAMPLE_CAP = 20

export interface TaskDigest {
  /** Tasks touched inside the window (by `updatedAt`), archived included. */
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  /** Touched but never filed a verdict — the supervision-contract leak. */
  readonly unreported: number
}

export interface RoutineDigest {
  readonly runs: number
  /** Per-status counts; only statuses actually seen appear. */
  readonly byStatus: Partial<Record<AutomationRunStatus, number>>
}

export interface DigestFailure {
  readonly taskId: string
  readonly title: string
  readonly summary?: string
  readonly reportedAt: string
}

export interface Digest {
  readonly repo: string
  readonly since: string
  readonly tasks: TaskDigest
  readonly routines: RoutineDigest
  readonly failures: readonly DigestFailure[]
  readonly provenance: string
}

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
function epochOf(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Fold already-filtered tasks + runs into the digest shape. Pure, so the
 * arithmetic is testable without a daemon; callers own repo/window filtering.
 */
export function buildDigest(
  repo: string,
  sinceMs: number,
  tasks: readonly SerializedTask[],
  runs: readonly AutomationRun[],
): Digest {
  const byStatus: Partial<Record<AutomationRunStatus, number>> = {}
  for (const run of runs) byStatus[run.status] = (byStatus[run.status] ?? 0) + 1

  let succeeded = 0
  let failed = 0
  const failures: DigestFailure[] = []
  for (const task of tasks) {
    const report = task.workerReport
    if (!report) continue
    if (report.outcome === "succeeded") {
      succeeded += 1
      continue
    }
    failed += 1
    failures.push({
      taskId: task.id,
      title: task.title,
      ...(report.summary ? { summary: report.summary } : {}),
      reportedAt: report.reportedAt,
    })
  }

  // Newest failure first: a digest is read to decide what to look at next.
  failures.sort((a, b) => (epochOf(b.reportedAt) ?? 0) - (epochOf(a.reportedAt) ?? 0))

  return {
    repo,
    since: new Date(sinceMs).toISOString(),
    tasks: { total: tasks.length, succeeded, failed, unreported: tasks.length - succeeded - failed },
    routines: { runs: runs.length, byStatus },
    failures: failures.slice(0, FAILURE_SAMPLE_CAP),
    provenance: "worker reports, not kobe-verified",
  }
}

export async function digest(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  const sinceMs = Date.now() - (args.int("since-days") ?? DEFAULT_SINCE_DAYS) * 86_400_000

  // Tasks: window membership is `updatedAt`, not the report time — a task that
  // worked all week and never filed a verdict must still land in `unreported`.
  const { tasks: allTasks } = await daemon.request<{ tasks: SerializedTask[] }>("task.list")
  const tasks: SerializedTask[] = []
  for (const task of allTasks) {
    // Only board CARDS are units of work. The repo's `main` seat (the
    // dispatcher) and `dir` entries never file a verdict, so counting them
    // would park a constant in `unreported` and mask the drift it exists to
    // show — a ruler with an offset is worse than no ruler.
    if ((task.kind ?? "task") !== "task") continue
    if ((epochOf(task.updatedAt) ?? 0) < sinceMs) continue
    if ((await runtime.resolveRepoRoot(task.repo)) === repo) tasks.push(task)
  }

  const { automations } = await daemon.request<{ automations: Automation[] }>("automation.list")
  const runs: AutomationRun[] = []
  for (const automation of automations) {
    if ((await runtime.resolveRepoRoot(automation.repo)) !== repo) continue
    const page = await daemon.request<{ runs: AutomationRun[] }>("automation.runs", { id: automation.id })
    for (const run of page.runs) {
      if ((epochOf(run.at) ?? 0) >= sinceMs) runs.push(run)
    }
  }

  return buildDigest(repo, sinceMs, tasks, runs)
}

/** Spec half of the digest verb — spread into {@link VERBS} in `verbs.ts`. */
export const DIGEST_VERB: VerbSpec = {
  name: "digest",
  summary:
    "Aggregate a repo's recent agent work: worker-reported succeeded/failed/unreported task counts plus routine run outcomes. Reads state kobe already persists — the measurement any workflow change has to move.",
  flags: [
    {
      name: "repo",
      type: "string",
      required: true,
      placeholder: "PATH",
      description: "Repo root (git toplevel). Relative paths resolve against $PWD.",
    },
    {
      name: "since-days",
      type: "int",
      default: String(DEFAULT_SINCE_DAYS),
      placeholder: "N",
      description: "Look-back window in days.",
    },
  ],
  handler: digest,
}
