import { logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import type { UpdateInfo } from "../version.ts"
import {
  type OrchestratorSignals,
  type TaskEngineState,
  type TaskJobState,
  decodeUiPrefsPayload,
  describePayload,
  deserializeTask,
  parseTranscriptActivityPayload,
  parseWorktreeChangesPayload,
  sameTranscriptActivityMap,
  sameWorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"

function pruneEngineState(tasks: readonly SerializedTask[], signals: OrchestratorSignals): void {
  const current = signals.engineStateAcc()
  if (current.size === 0) return
  const live = new Set(tasks.map((t) => t.id))
  let next: Map<string, TaskEngineState> | null = null
  for (const key of current.keys()) {
    if (live.has(key)) continue
    if (!next) next = new Map(current)
    next.delete(key)
  }
  if (next) signals.setEngineStateSig(next)
}

function pruneTaskJobs(tasks: readonly SerializedTask[], signals: OrchestratorSignals): void {
  const current = signals.taskJobsAcc()
  if (current.size === 0) return
  const live = new Set(tasks.map((t) => t.id))
  let next: Map<string, TaskJobState> | null = null
  for (const key of current.keys()) {
    if (live.has(key)) continue
    if (!next) next = new Map(current)
    next.delete(key)
  }
  if (next) signals.setTaskJobsSig(next)
}

export function handleOrchestratorEvent(name: string, payload: unknown, signals: OrchestratorSignals): void {
  if (name === "task.snapshot") {
    const value = (payload as { tasks?: SerializedTask[] } | undefined)?.tasks
    if (Array.isArray(value)) {
      signals.setTasks(value.map(deserializeTask))
      pruneEngineState(value, signals)
      pruneTaskJobs(value, signals)
    } else {
      logClientError("orch", `dropped task.snapshot event: tasks is not an array (got ${describePayload(value)})`)
    }
    return
  }
  if (name === "active-task") {
    const id = (payload as { taskId?: string | null } | undefined)?.taskId
    signals.setActiveTaskSig(typeof id === "string" ? id : null)
    return
  }
  if (name === "update") {
    const info = (payload as { info?: UpdateInfo | null } | undefined)?.info
    signals.setUpdateSig(info ?? null)
    return
  }
  if (name === "engine-state") {
    const p = payload as { taskId?: string; state?: TaskActivityState; detail?: EngineActivityDetail; at?: number }
    if (typeof p?.taskId !== "string" || typeof p.state !== "string") {
      logClientError(
        "orch",
        `dropped engine-state event: taskId/state must be strings (taskId=${describePayload(p?.taskId)}, state=${describePayload(p?.state)})`,
      )
      return
    }
    const next = new Map(signals.engineStateAcc())
    if (p.state === "idle") next.delete(p.taskId)
    else next.set(p.taskId, { state: p.state, detail: p.detail, at: typeof p.at === "number" ? p.at : 0 })
    signals.setEngineStateSig(next)
    return
  }
  if (name === "task.jobs") {
    const p = payload as { taskId?: string; kind?: string; phase?: string } | undefined
    if (typeof p?.taskId !== "string" || p.kind !== "ensureWorktree") {
      logClientError(
        "orch",
        `dropped task.jobs event: expected string taskId + kind "ensureWorktree" (taskId=${describePayload(p?.taskId)}, kind=${describePayload(p?.kind)})`,
      )
      return
    }
    const current = signals.taskJobsAcc()
    if (p.phase === "running") {
      const next = new Map(current)
      next.set(p.taskId, { kind: p.kind })
      signals.setTaskJobsSig(next)
      return
    }
    if ((p.phase === "done" || p.phase === "error") && current.has(p.taskId)) {
      const next = new Map(current)
      next.delete(p.taskId)
      signals.setTaskJobsSig(next)
    }
    return
  }
  if (name === "worktree.changes") {
    const next = parseWorktreeChangesPayload(payload)
    if (!next) {
      logClientError("orch", `dropped worktree.changes event: malformed changes payload (${describePayload(payload)})`)
      return
    }
    const current = signals.worktreeChangesAcc()
    if (current && sameWorktreeChangesMap(current, next)) return
    signals.setWorktreeChangesSig(next)
    return
  }
  if (name === "transcript.activity") {
    const next = parseTranscriptActivityPayload(payload)
    if (!next) {
      logClientError(
        "orch",
        `dropped transcript.activity event: malformed activity payload (${describePayload(payload)})`,
      )
      return
    }
    const current = signals.transcriptActivityAcc()
    if (current && sameTranscriptActivityMap(current, next)) return
    signals.setTranscriptActivitySig(next)
    return
  }
  if (name === "ui-prefs") {
    const decoded = decodeUiPrefsPayload(payload)
    if (!decoded) {
      const theme = (payload as { theme?: unknown } | undefined)?.theme
      logClientError("orch", `dropped ui-prefs event: theme must be a string (got ${describePayload(theme)})`)
      return
    }
    signals.setUiPrefsSig(decoded)
    return
  }
  if (name === "keybindings") {
    const p = payload as { rev?: number } | undefined
    if (typeof p?.rev !== "number") {
      logClientError("orch", `dropped keybindings event: rev must be a number (got ${describePayload(p?.rev)})`)
      return
    }
    signals.setKeybindingsRevSig(p.rev)
  }
}
