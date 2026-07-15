/**
 * Daemon push-channel event handling for `RemoteOrchestrator` — split out
 * of `remote-orchestrator.ts` (which was over the repo's 500-line
 * file-size cap) into its own file. Same behavior, moved verbatim:
 * `handleOrchestratorEvent` is the exact body of the old
 * `RemoteOrchestrator.handleEvent`, now taking an explicit
 * {@link OrchestratorSignals} deps bag instead of closing over `this`.
 */

import { logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import type { NoticeEventPayload, SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import type { UpdateInfo } from "../version.ts"
import {
  type AttentionInboxItem,
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

/**
 * Drop engine-state entries for tasks that no longer exist (leak guard).
 * The `engine-state` channel only removes an entry on an explicit `idle`
 * event for that taskId — a task deleted/pruned while non-idle (running /
 * permission-needed / error, the common delete case) never gets one, so
 * in a long-lived pane process the map grew one stale entry per deleted
 * task, forever. Reconcile against each `task.snapshot` instead: any key
 * absent from the authoritative task list is dead. Benign race: an
 * `engine-state` event arriving before the snapshot that introduces its
 * task would be dropped here — the next engine-state event re-adds it
 * (and in practice the daemon publishes the create snapshot before the
 * engine ever starts). No-op (no signal write) when nothing is stale.
 */
function pruneEngineState(tasks: readonly SerializedTask[], signals: OrchestratorSignals): void {
  const live = new Set(tasks.map((t) => t.id))
  const current = signals.engineStateAcc()
  if (current.size > 0) {
    let next: Map<string, TaskEngineState> | null = null
    for (const key of current.keys()) {
      if (live.has(key)) continue
      if (!next) next = new Map(current)
      next.delete(key)
    }
    if (next) signals.setEngineStateSig(next)
  }
  // Same leak guard for the per-tab map — a task deleted while a tab was
  // non-idle never gets its per-tab idle events on this client if it was
  // disconnected at the time.
  const tabs = signals.engineTabStateAcc()
  if (tabs.size > 0) {
    let nextTabs: Map<string, ReadonlyMap<string, TaskEngineState>> | null = null
    for (const key of tabs.keys()) {
      if (live.has(key)) continue
      if (!nextTabs) nextTabs = new Map(tabs)
      nextTabs.delete(key)
    }
    if (nextTabs) signals.setEngineTabStateSig(nextTabs)
  }
}

/**
 * Drop task-job entries for tasks that no longer exist — the same leak
 * guard as {@link pruneEngineState}. A `done`/`error` publish normally
 * clears the entry, but a task DELETED while its job runs (or a dropped
 * terminal frame across a reconnect) would otherwise pin a phantom
 * "materializing" row state forever in a long-lived pane process.
 * No-op (no signal write) when nothing is stale.
 */
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

/** The exact body of the old `RemoteOrchestrator.handleEvent`. */
export function handleOrchestratorEvent(name: string, payload: unknown, signals: OrchestratorSignals): void {
  if (name === "task.snapshot") {
    const value = (payload as { tasks?: SerializedTask[] } | undefined)?.tasks
    if (Array.isArray(value)) {
      signals.setTasks(value.map(deserializeTask))
      pruneEngineState(value, signals)
      pruneTaskJobs(value, signals)
    } else {
      // Dropping this leaves the task list frozen at the last good snapshot;
      // log the anomaly so a stuck-list incident is diagnosable.
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
    const p = payload as {
      taskId?: string
      tabId?: string
      state?: TaskActivityState
      detail?: EngineActivityDetail
      at?: number
    }
    if (typeof p?.taskId !== "string" || typeof p.state !== "string") {
      logClientError(
        "orch",
        `dropped engine-state event: taskId/state must be strings (taskId=${describePayload(p?.taskId)}, state=${describePayload(p?.state)})`,
      )
      return
    }
    const entry: TaskEngineState = { state: p.state, detail: p.detail, at: typeof p.at === "number" ? p.at : 0 }
    // Accumulate per-task into a fresh Map (new ref → re-render). A tabId-
    // carrying event updates BOTH levels: the daemon publishes one event per
    // report, and the task entry is its last-event-wins rollup.
    const next = new Map(signals.engineStateAcc())
    if (p.state === "idle") next.delete(p.taskId)
    else next.set(p.taskId, entry)
    signals.setEngineStateSig(next)
    if (typeof p.tabId === "string" && p.tabId) {
      const nextTabs = new Map(signals.engineTabStateAcc())
      const tabs = new Map(nextTabs.get(p.taskId) ?? [])
      if (p.state === "idle") tabs.delete(p.tabId)
      else tabs.set(p.tabId, entry)
      if (tabs.size > 0) nextTabs.set(p.taskId, tabs)
      else nextTabs.delete(p.taskId)
      signals.setEngineTabStateSig(nextTabs)
    }
    return
  }
  if (name === "attention.inbox") {
    const items = (payload as { items?: unknown } | undefined)?.items
    if (!Array.isArray(items)) {
      logClientError("orch", `dropped attention.inbox event: items is not an array (${describePayload(items)})`)
      return
    }
    const valid = items.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      const p = item as Partial<AttentionInboxItem>
      return (
        typeof p.taskId === "string" &&
        (p.tabId === null || typeof p.tabId === "string") &&
        (p.state === "turn_complete" ||
          p.state === "permission_needed" ||
          p.state === "error" ||
          p.state === "rate_limited") &&
        typeof p.at === "number"
      )
    })
    if (!valid) {
      logClientError("orch", `dropped attention.inbox event: malformed item (${describePayload(items)})`)
      return
    }
    signals.setAttentionInboxSig(items as AttentionInboxItem[])
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
    // Terminal phases (`done` / `error`) remove the entry. Skip the signal
    // write when nothing is tracked — a replayed terminal payload to a
    // late subscriber must be a true no-op, not a map-identity churn.
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
      // malformed → never clobber a good map, but log the drop.
      logClientError("orch", `dropped worktree.changes event: malformed changes payload (${describePayload(payload)})`)
      return
    }
    // Value-equality gate: an unchanged republish (bus replay across a
    // reconnect, or a daemon publish that round-trips to the same counts)
    // must not swap the map reference and re-render every sidebar row.
    const current = signals.worktreeChangesAcc()
    if (current && sameWorktreeChangesMap(current, next)) return
    signals.setWorktreeChangesSig(next)
    return
  }
  if (name === "transcript.activity") {
    const next = parseTranscriptActivityPayload(payload)
    if (!next) {
      // malformed → never clobber a good map, but log the drop.
      logClientError(
        "orch",
        `dropped transcript.activity event: malformed activity payload (${describePayload(payload)})`,
      )
      return
    }
    // Value-equality gate: an unchanged republish (bus replay across a
    // reconnect, or a daemon publish that round-trips to the same facts)
    // must not swap the map reference and re-run every Ops pane effect.
    const current = signals.transcriptActivityAcc()
    if (current && sameTranscriptActivityMap(current, next)) return
    signals.setTranscriptActivitySig(next)
    return
  }
  if (name === "notice.event") {
    const p = payload as Partial<NoticeEventPayload> | undefined
    if (typeof p?.title !== "string" || typeof p.at !== "number" || typeof p.kind !== "string") {
      logClientError("orch", `dropped notice.event: malformed payload (${describePayload(payload)})`)
      return
    }
    signals.setNoticeSig(p as NoticeEventPayload)
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
