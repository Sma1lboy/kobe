/**
 * `digest` — the RULER. An aggregate read over state Rove already persists:
 * tasks touched in the window and routine run outcomes
 * (`AutomationRun.status`). No new data model, no new writer.
 *
 * Why it exists: Rove runs a lot of unattended agent work (fan-out, routines,
 * the dispatcher) and had no way to answer "is this week better than last
 * week". Every self-improvement mechanism is astrology without a measurement
 * it can move, so the ruler ships before anything that claims to learn.
 *
 * Task OUTCOMES are deliberately absent: completion flows back to the
 * spawning agent's chat tab (`send`), not into Rove state — the stored
 * `workerReport` channel was removed because nothing read it.
 */

import type { Automation, AutomationRun, AutomationRunStatus } from "@sma1lboy/kobe-daemon/daemon/contracts"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { daemonOf } from "./handler-helpers.ts"
import type { VerbContext, VerbSpec } from "./types.ts"

/** Default look-back for a digest, in days. */
const DEFAULT_SINCE_DAYS = 7

export interface TaskDigest {
  /** Tasks touched inside the window (by `updatedAt`), archived included. */
  readonly total: number
}

export interface RoutineDigest {
  readonly runs: number
  /** Per-status counts; only statuses actually seen appear. */
  readonly byStatus: Partial<Record<AutomationRunStatus, number>>
}

export interface Digest {
  readonly repo: string
  readonly since: string
  readonly tasks: TaskDigest
  readonly routines: RoutineDigest
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

  return {
    repo,
    since: new Date(sinceMs).toISOString(),
    tasks: { total: tasks.length },
    routines: { runs: runs.length, byStatus },
  }
}

export async function digest(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  const { args, runtime } = ctx
  const repo = await runtime.resolveRepoRoot(args.requirePath("repo"))
  const sinceMs = Date.now() - (args.int("since-days") ?? DEFAULT_SINCE_DAYS) * 86_400_000

  const { tasks: allTasks } = await daemon.request<{ tasks: SerializedTask[] }>("task.list")
  const tasks: SerializedTask[] = []
  for (const task of allTasks) {
    // Only board CARDS are units of work — the repo's `main` seat (the
    // dispatcher) and `dir` entries would park a constant in the count.
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
    "Aggregate a repo's recent agent work: tasks touched in the window plus routine run outcomes. Reads state Rove already persists — the measurement any workflow change has to move.",
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
