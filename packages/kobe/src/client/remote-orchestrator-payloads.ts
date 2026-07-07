/**
 * Wire-payload types + pure parse/decode/compare helpers for
 * `RemoteOrchestrator` — split out of `remote-orchestrator.ts` (which was
 * over the repo's 500-line file-size cap) purely mechanically: same
 * types/functions, moved verbatim, re-exported from `remote-orchestrator.ts`
 * so existing importers (tests, `deserializeTask` callers) keep their path.
 *
 * Also defines {@link OrchestratorSignals} — the explicit "deps bag" of
 * accessor/setter closures `handleOrchestratorEvent`
 * (`remote-orchestrator-events.ts`) and `performInit`
 * (`remote-orchestrator-connect.ts`) operate on, instead of closing over
 * `RemoteOrchestrator`'s private fields directly. Solid signals are plain
 * closures (no `this` binding), so passing them across the file boundary
 * is exactly as cheap as calling them as methods.
 */

import type { ChannelName, SerializedTask, SubscribeRole, UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { Accessor } from "solid-js"
import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import { type WorktreeChanges, sameWorktreeChanges } from "../tui/panes/sidebar/worktree-changes.ts"
import type { Task } from "../types/task.ts"
import { toTaskId } from "../types/task.ts"
import type { UpdateInfo } from "../version.ts"

/** Per-task engine activity, accumulated from the daemon's `engine-state` channel. */
export interface TaskEngineState {
  readonly state: TaskActivityState
  readonly detail?: EngineActivityDetail
  readonly at: number
}

/**
 * A long daemon operation currently IN FLIGHT for a task, accumulated from
 * the `task.jobs` channel (today: `ensureWorktree` — `git worktree add` is
 * minute-class on a huge repo). Presence in the map means "running"; the
 * terminal phases (`done` / `error`) remove the entry, so a replayed
 * terminal payload to a late subscriber is a harmless no-op. The job's
 * outcome isn't surfaced here — the blocking RPC delivers it to the caller.
 */
export interface TaskJobState {
  readonly kind: "ensureWorktree"
}

/**
 * Daemon-collected `+N −M` counts keyed by worktree path, from the
 * `worktree.changes` channel (issue #6 — one collector in the daemon
 * instead of per-pane git polling). `null` means "no daemon-collected
 * data": either the daemon predates the channel (absent from
 * `hello.capabilities`) or `init()` hasn't completed — the sidebar then
 * falls back to its local poller.
 */
export type WorktreeChangesMap = ReadonlyMap<string, WorktreeChanges>

/**
 * Compact, bounded description of a dropped event payload for `client.log` —
 * enough to diagnose a malformed daemon frame (the type, and a short prefix of
 * its stringified form) without dumping a huge object into the log. Used only
 * on the drop paths in `handleOrchestratorEvent`.
 */
export function describePayload(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  const type = Array.isArray(value) ? "array" : typeof value
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text.length > 120) text = `${text.slice(0, 120)}…`
  return `${type}:${text}`
}

/**
 * Parse a `worktree.changes` wire payload into a path→counts map.
 * Returns `null` for a malformed payload (the event is then ignored —
 * never clobber a good map with garbage). Exported for unit tests.
 */
export function parseWorktreeChangesPayload(payload: unknown): Map<string, WorktreeChanges> | null {
  const changes = (payload as { changes?: unknown } | undefined)?.changes
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null
  const map = new Map<string, WorktreeChanges>()
  for (const [path, value] of Object.entries(changes as Record<string, unknown>)) {
    const counts = value as { added?: unknown; deleted?: unknown } | undefined
    if (typeof counts?.added !== "number" || typeof counts.deleted !== "number") return null
    map.set(path, { added: counts.added, deleted: counts.deleted })
  }
  return map
}

/**
 * Decode a `ui-prefs` wire payload into a fully-defaulted {@link UiPrefsPayload},
 * or `null` when it's unusable (no `theme` string — the event is then ignored).
 * The single owner of the backward-compat defaults: an older daemon omits newer
 * fields, and each MUST resolve to its "absent → leave it" sentinel rather than
 * a hard reset. These were inline in handleEvent, where the version-negotiation
 * intent was a wall of per-field fallbacks easy to get subtly wrong. Exported
 * for unit tests.
 *
 *  - `locale` absent → "" (UNSET): a payload that never mentioned the language
 *    must not yank it back to English; only a real non-empty locale changes it.
 *  - `sortMode` absent → "default"; `keysCollapsed` absent → false (expanded);
 *    `projectFilter` absent/empty → null (all projects); `transparentBackground`
 *    / `focusAccent` default off / null.
 */
export function decodeUiPrefsPayload(payload: unknown): UiPrefsPayload | null {
  const p = payload as Partial<UiPrefsPayload> | undefined
  if (typeof p?.theme !== "string") return null
  return {
    theme: p.theme,
    transparentBackground: p.transparentBackground === true,
    focusAccent: typeof p.focusAccent === "string" ? p.focusAccent : null,
    locale: typeof p.locale === "string" ? p.locale : "",
    sortMode: p.sortMode === "recent" ? "recent" : "default",
    keysCollapsed: p.keysCollapsed === true,
    projectFilter: typeof p.projectFilter === "string" && p.projectFilter.length > 0 ? p.projectFilter : null,
    reducedMotion: p.reducedMotion === true,
  }
}

/**
 * Entry-wise equality for two changes maps — an unchanged republish (e.g.
 * the bus replaying its last value across a reconnect) must not churn the
 * signal and re-render every sidebar row. Exported for unit tests.
 */
export function sameWorktreeChangesMap(a: WorktreeChangesMap, b: WorktreeChangesMap): boolean {
  if (a.size !== b.size) return false
  for (const [path, counts] of a) {
    const other = b.get(path)
    if (!other || !sameWorktreeChanges(counts, other)) return false
  }
  return true
}

/**
 * One worktree's daemon-collected transcript facts (perf — deduplicate
 * per-Ops-pane polling), from the `transcript.activity` channel: the newest
 * engine-transcript mtime (drives the Ops pane's `● new` badge) plus the
 * engine-owned latest-completion marker (drives the ChatTab "done" chip).
 * The per-window tmux quiescence check stays in the Ops pane — this is only
 * the shareable filesystem half.
 */
export interface TranscriptActivity {
  readonly mtimeMs: number
  readonly completionId: string | null
  readonly completionAt: number
}

/**
 * Daemon-collected transcript facts keyed by worktree path, from the
 * `transcript.activity` channel. `null` means "no daemon-collected data":
 * either the daemon predates the channel (absent from `hello.capabilities`)
 * or `init()` hasn't completed — the Ops pane then falls back to its local
 * mtime/completion polling.
 */
export type TranscriptActivityMap = ReadonlyMap<string, TranscriptActivity>

/**
 * Parse a `transcript.activity` wire payload into a path→facts map. Returns
 * `null` for a malformed payload (the event is then ignored — never clobber
 * a good map with garbage). Exported for unit tests.
 */
export function parseTranscriptActivityPayload(payload: unknown): Map<string, TranscriptActivity> | null {
  const activity = (payload as { activity?: unknown } | undefined)?.activity
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null
  const map = new Map<string, TranscriptActivity>()
  for (const [path, value] of Object.entries(activity as Record<string, unknown>)) {
    const v = value as { mtimeMs?: unknown; completionId?: unknown; completionAt?: unknown } | undefined
    if (typeof v?.mtimeMs !== "number" || typeof v.completionAt !== "number") return null
    if (v.completionId !== null && typeof v.completionId !== "string") return null
    map.set(path, { mtimeMs: v.mtimeMs, completionId: v.completionId, completionAt: v.completionAt })
  }
  return map
}

/** Entry-wise value equality for two transcript-activity maps. Exported for unit tests. */
export function sameTranscriptActivityMap(a: TranscriptActivityMap, b: TranscriptActivityMap): boolean {
  if (a.size !== b.size) return false
  for (const [path, v] of a) {
    const other = b.get(path)
    if (
      !other ||
      other.mtimeMs !== v.mtimeMs ||
      other.completionId !== v.completionId ||
      other.completionAt !== v.completionAt
    )
      return false
  }
  return true
}

/**
 * Daemon connection lifecycle as observed by the TUI. Two states
 * because reconnect is user-driven (the host shows a "Restart daemon
 * or Quit?" prompt when we go `disconnected`).
 */
export type DaemonConnectionState = "online" | "disconnected"

export interface RemoteOrchestratorOptions {
  /**
   * Bring the daemon back on the socket this client already points
   * at. Shared mode uses the stable production socket; single/owned
   * mode injects a restart function for its per-TUI socket.
   */
  readonly ensureReachable?: () => Promise<unknown>
  /**
   * Subscribe role (KOB). `"gui"` keeps the daemon alive while this
   * orchestrator is connected — pass it only from a real front-end attach
   * (`direct.ts`, the outer monitor). Default `"pane"`: an in-tmux helper
   * (Tasks pane, Ops, settings/new-task windows) subscribes for data but
   * never holds the daemon open after the user quits. See {@link SubscribeRole}.
   */
  readonly role?: SubscribeRole
  /**
   * Per-channel subscribe filter (KOB — per-channel subscribe). Omit to
   * receive EVERY channel (the default — what a primary orchestrator
   * driving the task list needs). Pass a narrow set for a single-purpose
   * consumer: host-boot's UiPrefsSync passes `["ui-prefs", "keybindings"]`
   * so it no longer receives — nor deserializes — the full `task.snapshot`
   * fan-out it never reads. When the filter excludes `task.snapshot`, the
   * `hello` task hydration is also skipped (the task list would be dead
   * weight), and `worktreeChangesSignal()` is left null (its consumer isn't
   * subscribed). An older daemon ignores the filter and sends everything;
   * the unread channels simply land in signals nobody reads — still cheaper
   * to ask, and correct.
   */
  readonly channels?: readonly ChannelName[]
}

/**
 * The accessor/setter closures `handleOrchestratorEvent` and `performInit`
 * operate on, threaded in by `RemoteOrchestrator` instead of `this`. Built
 * once in the constructor from the same Solid signals the class's own
 * read-signal methods return.
 */
export interface OrchestratorSignals {
  readonly tasksAcc: Accessor<Task[]>
  readonly setTasks: (next: Task[]) => void
  readonly setActiveTaskSig: (next: string | null) => void
  readonly setUpdateSig: (next: UpdateInfo | null) => void
  readonly setDaemonVersionSig: (next: string | null) => void
  readonly engineStateAcc: Accessor<ReadonlyMap<string, TaskEngineState>>
  readonly setEngineStateSig: (next: ReadonlyMap<string, TaskEngineState>) => void
  readonly taskJobsAcc: Accessor<ReadonlyMap<string, TaskJobState>>
  readonly setTaskJobsSig: (next: ReadonlyMap<string, TaskJobState>) => void
  readonly worktreeChangesAcc: Accessor<WorktreeChangesMap | null>
  readonly setWorktreeChangesSig: (next: WorktreeChangesMap | null) => void
  readonly transcriptActivityAcc: Accessor<TranscriptActivityMap | null>
  readonly setTranscriptActivitySig: (next: TranscriptActivityMap | null) => void
  readonly setUiPrefsSig: (next: UiPrefsPayload | null) => void
  readonly setKeybindingsRevSig: (next: number | null) => void
  readonly setConnectionState: (next: DaemonConnectionState) => void
}

export function deserializeTask(s: SerializedTask): Task {
  return {
    id: toTaskId(s.id),
    title: s.title,
    repo: s.repo,
    branch: s.branch,
    worktreePath: s.worktreePath,
    kind: s.kind,
    status: s.status,
    archived: s.archived,
    pinned: s.pinned,
    vendor: s.vendor,
    prStatus: s.prStatus,
    modelEffort: s.modelEffort,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}
