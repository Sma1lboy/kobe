import { spawn } from "node:child_process"
import {
  GH_PR_VIEW_FIELDS,
  type GhPrView,
  type PrBackoffConfig,
  type PrViewErrorKind,
  classifyGhFailure,
  mapGhPrView,
  nextPrPoll,
  samePrStatus,
} from "@/monitor/pr-status"
import type { Orchestrator } from "@/orchestrator/core"
import { isRemoteRepoKey } from "@/state/repos"
import type { Task } from "@/types/task"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"

export const DEFAULT_PR_STATUS_POLL_MS = 30_000
export const NO_PR_BACKOFF_MS = 5 * 60_000
export const SETTLED_BACKOFF_MS = 10 * 60_000
export const PR_FAILURE_BASE_MS = DEFAULT_PR_STATUS_POLL_MS
export const PR_FAILURE_CAP_MS = 15 * 60_000
export const NO_REMOTE_BACKOFF_MS = 30 * 60_000
export const PR_POLL_JITTER_RATIO = 0.2
export const PR_VIEW_TIMEOUT_MS = 10_000

export type PrViewResult =
  | { kind: "pr"; view: GhPrView }
  | { kind: "empty" }
  | { kind: "error"; error: PrViewErrorKind }

export type PrViewRunner = (worktreePath: string, branch: string) => Promise<PrViewResult>

interface GhSpawnResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: boolean
}

function spawnGh(args: readonly string[], cwd: string, signal: AbortSignal): Promise<GhSpawnResult> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let settled = false
    const finish = (status: number | null, spawnError: boolean): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: out, stderr: err, spawnError })
    }
    const child = spawn("gh", args.slice(), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
    })
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      err += String(chunk)
    })
    child.on("error", () => finish(null, !signal.aborted))
    child.on("close", (code) => finish(code, false))
  })
}

export const runGhPrView: PrViewRunner = async (worktreePath, branch) => {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PR_VIEW_TIMEOUT_MS)
  try {
    const res = await spawnGh(["pr", "view", branch, "--json", GH_PR_VIEW_FIELDS], worktreePath, controller.signal)
    if (res.status === 0 && !timedOut) {
      try {
        const view = JSON.parse(res.stdout) as GhPrView
        return typeof view.number === "number" ? { kind: "pr", view } : { kind: "empty" }
      } catch {
        return classifyGhFailure({ parseError: true })
      }
    }
    return classifyGhFailure({
      spawnError: res.spawnError,
      timedOut,
      exitCode: res.status,
      stderr: res.stderr,
    })
  } finally {
    clearTimeout(timer)
  }
}

export function isPrPollable(task: Task): boolean {
  if (task.archived) return false
  if (task.kind === "main") return false
  if (!task.branch || !task.worktreePath) return false
  if (isRemoteRepoKey(task.repo) || isRemoteRepoKey(task.worktreePath)) return false
  return true
}

export interface PrPollEntry {
  readonly nextAllowedAt: number
  readonly failures: number
}

export type PrPollSchedule = Map<string, PrPollEntry>

export interface PrStatusPassOptions {
  readonly run: PrViewRunner
  readonly now: number
  readonly at: string
  readonly schedule: PrPollSchedule
  readonly tickMs?: number
  readonly rand?: () => number
}

export async function runPrStatusPass(orch: Orchestrator, opts: PrStatusPassOptions): Promise<string[]> {
  const tickMs = opts.tickMs ?? DEFAULT_PR_STATUS_POLL_MS
  const rand = opts.rand
  const cfg: PrBackoffConfig = {
    tickMs,
    settledMs: SETTLED_BACKOFF_MS,
    noPrMs: NO_PR_BACKOFF_MS,
    noRemoteMs: NO_REMOTE_BACKOFF_MS,
    failureBaseMs: PR_FAILURE_BASE_MS,
    failureCapMs: PR_FAILURE_CAP_MS,
    jitterRatio: PR_POLL_JITTER_RATIO,
  }
  const changed: string[] = []
  for (const task of orch.listTasks()) {
    if (!isPrPollable(task)) {
      opts.schedule.delete(task.id)
      continue
    }
    const entry = opts.schedule.get(task.id)
    if (entry && opts.now < entry.nextAllowedAt) continue
    const prevFailures = entry?.failures ?? 0
    try {
      const result = await opts.run(task.worktreePath, task.branch)
      if (result.kind === "error") {
        logDaemonInfo(
          "pr-status-poller",
          `gh pr view failed (${result.error}) for task ${task.id} [${task.branch}] — keeping last PR status, backing off`,
        )
        opts.schedule.set(
          task.id,
          nextPrPoll({ kind: "error", error: result.error }, prevFailures, opts.now, cfg, rand),
        )
        continue
      }
      if (result.kind === "empty") {
        opts.schedule.set(task.id, nextPrPoll({ kind: "empty" }, prevFailures, opts.now, cfg, rand))
        continue
      }
      const next = mapGhPrView(result.view, opts.at)
      const current = orch.getTask(task.id)
      if (!current) {
        opts.schedule.delete(task.id)
        continue
      }
      if (!samePrStatus(current.prStatus, next ?? undefined)) {
        await orch.setPRStatus(task.id, next)
        changed.push(task.id)
      }
      const settled = next?.lifecycle === "merged" || next?.lifecycle === "closed"
      opts.schedule.set(task.id, nextPrPoll({ kind: "pr", settled }, prevFailures, opts.now, cfg, rand))
    } catch (err) {
      logDaemonError("pr-status-poller", err)
      opts.schedule.set(task.id, nextPrPoll({ kind: "error", error: "network" }, prevFailures, opts.now, cfg, rand))
    }
  }
  return changed
}

export function startPrStatusPoller(
  orch: Orchestrator,
  intervalMs: number = DEFAULT_PR_STATUS_POLL_MS,
  hasSubscribers?: () => boolean,
  run: PrViewRunner = runGhPrView,
): () => void {
  if (intervalMs <= 0) return () => {}
  const schedule: PrPollSchedule = new Map()
  let running = false
  const tick = (): void => {
    if (hasSubscribers && !hasSubscribers()) return
    if (running) return
    running = true
    void runPrStatusPass(orch, { run, now: Date.now(), at: new Date().toISOString(), schedule, tickMs: intervalMs })
      .catch((err) => logDaemonError("pr-status-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
