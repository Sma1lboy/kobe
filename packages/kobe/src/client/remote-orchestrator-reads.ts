/**
 * `RemoteOrchestrator`'s read surface — split out of `remote-orchestrator.ts`
 * (which was over the repo's 500-line file-size cap) into its own file; same
 * behavior/docs, moved verbatim (mirrors the `-writes.ts` split). The class
 * keeps its public method names/signatures — each is now a 1-line delegate
 * to the matching function here, operating on the {@link ReadSignals} bag
 * (a superset of `OrchestratorSignals` — the extra fields are the
 * framework-free store twins and connection-state accessor that
 * `performInit`/`handleOrchestratorEvent` don't need).
 */

import { type UiPrefsPayload, isDaemonVersionStale } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type Accessor, createEffect, createRoot } from "solid-js"
import type { ExternalStore } from "../lib/external-store.ts"
import type { Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId } from "../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../version.ts"
import type {
  DaemonConnectionState,
  TaskEngineState,
  TaskJobState,
  TranscriptActivityMap,
  WorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"

/** The fields these read accessors need off `RemoteOrchestrator`. */
export interface ReadSignals {
  readonly tasksAcc: Accessor<Task[]>
  readonly activeTaskAcc: Accessor<string | null>
  readonly updateAcc: Accessor<UpdateInfo | null>
  readonly daemonVersionAcc: Accessor<string | null>
  readonly engineStateAcc: Accessor<ReadonlyMap<string, TaskEngineState>>
  readonly taskJobsAcc: Accessor<ReadonlyMap<string, TaskJobState>>
  readonly worktreeChangesAcc: Accessor<WorktreeChangesMap | null>
  readonly transcriptActivityAcc: Accessor<TranscriptActivityMap | null>
  readonly transcriptActivityStoreInner: ExternalStore<TranscriptActivityMap | null>
  readonly uiPrefsAcc: Accessor<UiPrefsPayload | null>
  readonly uiPrefsStoreInner: ExternalStore<UiPrefsPayload | null>
  readonly keybindingsRevAcc: Accessor<number | null>
  readonly keybindingsRevStoreInner: ExternalStore<number | null>
  readonly connectionStateAcc: Accessor<DaemonConnectionState>
}

export function tasksSignalOp(s: ReadSignals): Accessor<Task[]> {
  return s.tasksAcc
}

/** Shared active task id (session last switched/entered), pushed live on
 *  `active-task` — every surface highlights the SAME focus. */
export function activeTaskSignalOp(s: ReadSignals): Accessor<string | null> {
  return s.activeTaskAcc
}

/**
 * Latest published-version info, pushed live on the daemon-owned `update`
 * channel (the daemon polls npm once and fans it out — panes don't poll
 * the registry themselves). `null` until the first check resolves, or when
 * the check is suppressed (dev) / unavailable (offline).
 */
export function updateSignalOp(s: ReadSignals): Accessor<UpdateInfo | null> {
  return s.updateAcc
}

/**
 * The daemon's reported BUILD version (from the `hello` handshake), or
 * `null` when unknown — an older daemon that predates the field, or before
 * `init()` has resolved. Distinct from {@link updateSignalOp} ("a newer kobe
 * exists on npm") — this is "what version is the daemon I'm talking to".
 */
export function daemonVersionSignalOp(s: ReadSignals): Accessor<string | null> {
  return s.daemonVersionAcc
}

/**
 * Derived: is the daemon running a DIFFERENT build than this process
 * (you upgraded the binary but the long-lived daemon — Bun has no
 * hot-reload — is still running old code)? NON-fatal, drives the
 * dismissible restart banner. `false` while unknown, so no false banner
 * pre-handshake or on an old daemon; clears once a restarted daemon
 * reports the matching version.
 */
export function daemonStaleSignalOp(s: ReadSignals): Accessor<boolean> {
  return () => isDaemonVersionStale(s.daemonVersionAcc() ?? undefined, CURRENT_VERSION)
}

/**
 * Per-task engine activity (running / turn-complete / rate-limited /
 * permission-needed / error), pushed live on the daemon's `engine-state`
 * channel from engine hooks. The transient, event-driven counterpart to the
 * lifecycle `tasksSignal()` — the sidebar reads it for real-time badges.
 */
export function engineStateSignalOp(s: ReadSignals): Accessor<ReadonlyMap<string, TaskEngineState>> {
  return s.engineStateAcc
}

/**
 * Long daemon operations currently in flight, keyed by taskId — pushed
 * live on the `task.jobs` channel (today: `ensureWorktree`, minute-class
 * on a huge repo). The Tasks pane reads it to show a "materializing" row
 * state in EVERY attached pane while the blocking RPC runs, not just the
 * one that initiated it. Entries are removed on the terminal phases and
 * pruned against each `task.snapshot` (same leak guard as engine-state).
 */
export function taskJobsSignalOp(s: ReadSignals): Accessor<ReadonlyMap<string, TaskJobState>> {
  return s.taskJobsAcc
}

/**
 * Daemon-collected `+N −M` uncommitted-change counts keyed by worktree
 * path, pushed live on the `worktree.changes` channel (issue #6 — ONE
 * collector in the daemon instead of per-pane git polling). `null` =
 * no daemon-collected data (old daemon without the channel, or before
 * `init()`): the sidebar then falls back to its local poller; non-null
 * means "render pushes, spawn zero git processes".
 *
 * Unlike `engine-state` / `task.jobs` there is NO per-snapshot prune:
 * each push REPLACES the whole map (the daemon publishes the full
 * picture and drops deleted/archived tasks' entries itself on its next
 * tick), so stale keys cannot accumulate in a long-lived pane.
 */
export function worktreeChangesSignalOp(s: ReadSignals): Accessor<WorktreeChangesMap | null> {
  return s.worktreeChangesAcc
}

/**
 * Daemon-collected transcript facts keyed by worktree path, pushed live on
 * the `transcript.activity` channel (perf — deduplicate per-Ops-pane
 * polling): the newest transcript mtime (the `● new` badge source) + the
 * engine-owned latest-completion marker (the ChatTab "done" chip source).
 * `null` = no daemon-collected data (old daemon, or before `init()`): the
 * Ops pane falls back to local probes. Same whole-map-replace semantics as
 * {@link worktreeChangesSignalOp} (no per-snapshot prune needed).
 */
export function transcriptActivitySignalOp(s: ReadSignals): Accessor<TranscriptActivityMap | null> {
  return s.transcriptActivityAcc
}

/** Framework-free twin of {@link transcriptActivitySignalOp} — see uiPrefsStoreOp. */
export function transcriptActivityStoreOp(s: ReadSignals): ExternalStore<TranscriptActivityMap | null> {
  return s.transcriptActivityStoreInner
}

/**
 * The persisted visual prefs (theme / transparent / focus accent),
 * pushed live on the daemon's `ui-prefs` channel from its state-file
 * watcher. `null` until the first payload arrives (e.g. before the
 * subscribe replay, or talking to an older daemon without the channel).
 * Consumed by every pane host's boot sequence (`tui/lib/host-boot.tsx`)
 * to re-apply appearance changes live across all task sessions.
 */
export function uiPrefsSignalOp(s: ReadSignals): Accessor<UiPrefsPayload | null> {
  return s.uiPrefsAcc
}

/**
 * Framework-free twin of {@link uiPrefsSignalOp} for React hosts: a
 * subscribe/get pair that notifies in every runtime. Same values,
 * same nullability, one writer (the setter dual-writes).
 */
export function uiPrefsStoreOp(s: ReadSignals): ExternalStore<UiPrefsPayload | null> {
  return s.uiPrefsStoreInner
}

/**
 * The keybindings-file revision, bumped on the daemon's `keybindings`
 * channel whenever `~/.kobe/settings/keybindings.yaml` changes. An opaque
 * token — a consumer re-reads + re-applies the file on each transition.
 * `null` until the first payload. Consumed by host-boot's `UiPrefsSync`
 * to live-reload keys across every pane.
 */
export function keybindingsRevSignalOp(s: ReadSignals): Accessor<number | null> {
  return s.keybindingsRevAcc
}

/** Framework-free twin of {@link keybindingsRevSignalOp} — see uiPrefsStoreOp. */
export function keybindingsRevStoreOp(s: ReadSignals): ExternalStore<number | null> {
  return s.keybindingsRevStoreInner
}

export function listTasksOp(s: ReadSignals): Task[] {
  return s.tasksAcc()
}

export function getTaskOp(s: ReadSignals, id: TaskId | string): Task | undefined {
  return s.tasksAcc().find((t) => t.id === id)
}

export function subscribeTasksOp(s: ReadSignals, listener: (snapshot: readonly Task[]) => void): Unsubscribe {
  try {
    listener(listTasksOp(s))
  } catch (err) {
    console.error("[kobe RemoteOrchestrator] task listener threw on subscribe:", err)
  }
  // Forward subsequent snapshots reactively off the Solid signal instead
  // of polling it on a timer. createEffect re-runs whenever tasksAcc()
  // changes; createRoot gives it an owner so the returned disposer tears
  // it down. The effect fires once synchronously on creation — skip that
  // run since we already delivered the current snapshot eagerly above.
  let first = true
  return createRoot((dispose) => {
    createEffect(() => {
      const current = s.tasksAcc()
      if (first) {
        first = false
        return
      }
      try {
        listener(current)
      } catch (err) {
        console.error("[kobe RemoteOrchestrator] task listener threw:", err)
      }
    })
    return dispose
  })
}
