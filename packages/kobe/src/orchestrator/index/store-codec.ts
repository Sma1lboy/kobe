/**
 * Pure I/O internals for {@link TaskIndexStore} (`store.ts`).
 *
 * Two `this`-independent concerns that would otherwise bloat the store:
 *
 *   - **Lock-retry policy.** {@link acquireWithRetry} wraps the raw
 *     `lockfile.ts` `acquire` with the fixed-backoff wait a contended
 *     machine needs, so the store's `doSave` critical section is a plain
 *     acquire/try/release.
 *   - **On-disk codec.** {@link normalizeIndex} + {@link coerceTask} turn an
 *     arbitrary parsed JSON value into a v3 task list, migrating v1/v2
 *     manifests by stripping dropped fields and self-healing legacy status
 *     rows. Used by both `load()` and the read-merge-write's disk read.
 *
 * All functions here are pure (no store state) — moved out verbatim so the
 * store class stays under the file-size cap.
 */

import { copyFile } from "node:fs/promises"
import type {
  Task,
  TaskDeletionState,
  TaskDispatcher,
  TaskLinkedWorkItem,
  TaskPRStatus,
  TaskQuotaResumeState,
  TaskStatus,
} from "../../types/task.ts"
import { toTaskId } from "../../types/task.ts"
import { coerceVendorId } from "../../types/vendor.ts"
import { LockfileError, acquire } from "./lockfile.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll interval while another kobe instance briefly holds the index lock. */
const LOCK_RETRY_DELAY_MS = 25
/**
 * How long to keep retrying before giving up. Holds are millisecond-scale
 * (one read-merge-write), so 5s is generous headroom for a contended machine;
 * past it we surface the {@link LockfileError} rather than block a UI thread.
 */
const LOCK_MAX_WAIT_MS = 5_000

/**
 * Acquire the index lock, retrying with a fixed backoff while it's held by a
 * *live* peer. {@link acquire} rejects immediately on a live holder (and steals
 * a stale one on its own), so the wait policy lives here. Non-contention errors
 * (and a blown deadline) propagate to the caller.
 */
export async function acquireWithRetry(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      await acquire(lockPath)
      return
    } catch (err) {
      if (!(err instanceof LockfileError) || Date.now() >= deadline) throw err
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }
}

const CURRENT_VERSION = 3 as const

/**
 * Copy a corrupt manifest's ORIGINAL bytes aside before the store recovers
 * to an empty index. Without this, the next save read-merge-writes from the
 * empty recovery base and REPLACES the corrupt file — permanently
 * destroying whatever tasks its bytes still held (ported from PR #276).
 * Best-effort: a backup failure must never block startup/save; returns the
 * backup path for the caller's warn line, or null when the copy failed.
 */
export async function backupCorruptManifest(path: string, now: () => Date = () => new Date()): Promise<string | null> {
  const backupPath = `${path}.corrupt-${now().toISOString().replaceAll(":", "-")}`
  try {
    await copyFile(path, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * Normalize an arbitrary JSON value into a v3 cache. Migrates v1 / v2
 * manifests by stripping the dropped fields (`tabs`, `activeTabId`,
 * `sessionId`, `model`, `modelEffort`, `permissionMode`). The first
 * save after load persists the v3 shape.
 */
export function normalizeIndex(parsed: unknown, source: string): { version: typeof CURRENT_VERSION; tasks: Task[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[rove] tasks.json at ${source} is not an object; recovering with empty index.`)
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const obj = parsed as { version?: unknown; tasks?: unknown }
  const version = obj.version
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    console.warn(
      `[rove] tasks.json at ${source} has unsupported version=${String(version)}; recovering with empty index.`,
    )
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks: Task[] = []
  for (const entry of rawTasks) {
    const task = coerceTask(entry)
    if (task) tasks.push(task)
    else {
      console.warn(`[rove] dropping malformed task entry from ${source}: ${JSON.stringify(entry)}`)
    }
  }
  return { version: CURRENT_VERSION, tasks }
}

/**
 * Coerce one persisted task entry into a v3 {@link Task}. Tolerant of
 * v1 / v2 shapes — silently drops the dropped fields.
 */
function coerceTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (
    typeof v.id !== "string" ||
    typeof v.title !== "string" ||
    typeof v.repo !== "string" ||
    typeof v.branch !== "string" ||
    typeof v.worktreePath !== "string" ||
    typeof v.status !== "string" ||
    typeof v.createdAt !== "string" ||
    typeof v.updatedAt !== "string"
  ) {
    return null
  }
  if (!isTaskStatus(v.status)) return null

  // Self-heal pre-fix rows. Old kobe builds auto-flipped status to "done"
  // on every clean turn end, leaving the active sidebar full of `done`
  // tasks whose `archived` was still false. `done` is now reserved for
  // user-driven archive — heal those rows back to `in_progress` on load
  // so the sidebar's ✓ glyph only ever means "user archived this as
  // complete." Archived `done` rows are left alone.
  const archived = typeof v.archived === "boolean" ? v.archived : false
  const kind: Task["kind"] = v.kind === "main" ? "main" : v.kind === "dir" ? "dir" : "task"
  // Scratch only means anything on a dir task — a corrupt flag elsewhere is
  // dropped rather than inventing a Scratch worktree row.
  const scratch = kind === "dir" && v.scratch === true
  // A `main` (project root) task has NO session lifecycle that maintains
  // its status — nothing ever flips it to in_progress on a turn start or
  // back to backlog on a turn end. So a persisted in_progress/done on a
  // main row is junk (it came from the old auto-done flip, then the
  // done→in_progress heal below, leaving the project permanently stuck
  // showing the "working" chip). Reset a main row to a neutral backlog so
  // the project's liveness comes ONLY from a real live engine handle.
  const healedStatus: TaskStatus =
    kind === "main"
      ? v.status === "in_progress" || v.status === "done"
        ? "backlog"
        : v.status
      : v.status === "done" && !archived
        ? "in_progress"
        : v.status
  const deletion = coerceDeletion(v.deletion)
  const quotaResume = coerceQuotaResume(v.quotaResume)
  const linkedWorkItem = coerceLinkedWorkItem(v.linkedWorkItem)
  const dispatcher = coerceDispatcher(v.dispatcher)

  return {
    id: toTaskId(v.id),
    title: v.title,
    repo: v.repo,
    branch: v.branch,
    worktreePath: v.worktreePath,
    status: healedStatus,
    archived,
    pinned: typeof v.pinned === "boolean" ? v.pinned : false,
    kind,
    ...(scratch ? { scratch: true } : {}),
    vendor: coerceVendorId(typeof v.vendor === "string" ? v.vendor : undefined),
    // Raw launch command (`add --command` / `set-command`) — must survive
    // the load coercion or the task falls back to its protocol's preset on
    // every daemon restart, silently dropping the user's own command line.
    ...(typeof v.command === "string" && v.command.trim().length > 0 ? { command: v.command } : {}),
    prStatus: coercePRStatus(v.prStatus),
    // Web-board ordering key — must survive the load coercion or every
    // daemon restart silently forgets the user's column order.
    ...(typeof v.position === "number" && Number.isFinite(v.position) ? { position: v.position } : {}),
    // Engine reasoning/effort level — must survive the load coercion or the
    // task forgets its effort on every daemon restart.
    ...(typeof v.modelEffort === "string" && v.modelEffort.length > 0 ? { modelEffort: v.modelEffort } : {}),
    // Fan-out round marker — must survive the load coercion or siblings
    // lose their grouping on every daemon restart.
    ...(typeof v.groupId === "string" && v.groupId.length > 0 ? { groupId: v.groupId } : {}),
    ...(deletion ? { deletion } : {}),
    // The optional records below were written to disk but silently dropped
    // on load, so each survived only until the next daemon restart: a
    // pending quota resume was forgotten by the very runner whose
    // durability rationale is "absolute timestamp on disk", and a task
    // lost the tracker item it was started from.
    ...(quotaResume ? { quotaResume } : {}),
    ...(linkedWorkItem ? { linkedWorkItem } : {}),
    // Reply address for the collaboration loop (issue #21) — must survive the
    // load coercion or a daemon restart severs every sub-task's route home.
    // Records that predate the field normalize to undefined.
    ...(dispatcher ? { dispatcher } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

function coerceDispatcher(value: unknown): TaskDispatcher | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.taskId !== "string" || v.taskId.length === 0) return undefined
  if (typeof v.tabId !== "string" || v.tabId.length === 0) return undefined
  return { taskId: v.taskId, tabId: v.tabId }
}

function coerceQuotaResume(value: unknown): TaskQuotaResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.resumeAt !== "string" || v.resumeAt.length === 0) return undefined
  if (typeof v.requestedAt !== "string" || v.requestedAt.length === 0) return undefined
  return { resumeAt: v.resumeAt, requestedAt: v.requestedAt }
}

function coerceLinkedWorkItem(value: unknown): TaskLinkedWorkItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (v.provider !== "github") return undefined
  if (v.type !== "issue" && v.type !== "pr") return undefined
  if (typeof v.number !== "number" || !Number.isFinite(v.number)) return undefined
  if (typeof v.title !== "string" || typeof v.url !== "string" || v.url.length === 0) return undefined
  return { provider: v.provider, type: v.type, number: v.number, title: v.title, url: v.url }
}

function coerceDeletion(value: unknown): TaskDeletionState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (
    (v.phase !== "queued" && v.phase !== "running" && v.phase !== "error") ||
    typeof v.force !== "boolean" ||
    typeof v.requestedAt !== "string" ||
    v.requestedAt.length === 0 ||
    (v.error !== undefined && typeof v.error !== "string")
  ) {
    return undefined
  }
  return {
    phase: v.phase,
    force: v.force,
    requestedAt: v.requestedAt,
    // Round-trip the branch-cleanup opt-in: deletion is a persisted,
    // daemon-owned state machine, so a deletion queued with `deleteBranch`
    // that survives a restart must still delete the branch on `finish()`.
    ...(typeof v.deleteBranch === "boolean" ? { deleteBranch: v.deleteBranch } : {}),
    ...(typeof v.error === "string" ? { error: v.error } : {}),
  }
}

function coercePRStatus(value: unknown): TaskPRStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (!isPRProviderId(v.provider) || !isPRLifecycleState(v.lifecycle) || !isPRCheckState(v.checkState)) {
    return undefined
  }
  return {
    provider: v.provider,
    lifecycle: v.lifecycle,
    checkState: v.checkState,
    ...(typeof v.number === "number" && Number.isFinite(v.number) ? { number: v.number } : {}),
    ...(typeof v.url === "string" ? { url: v.url } : {}),
    ...(typeof v.title === "string" ? { title: v.title } : {}),
    ...(typeof v.baseRef === "string" ? { baseRef: v.baseRef } : {}),
    ...(typeof v.headRef === "string" ? { headRef: v.headRef } : {}),
    ...(typeof v.reviewDecision === "string" ? { reviewDecision: v.reviewDecision } : {}),
    ...(typeof v.mergeable === "string" ? { mergeable: v.mergeable } : {}),
    ...(typeof v.lastCheckedAt === "string" ? { lastCheckedAt: v.lastCheckedAt } : {}),
    ...(typeof v.lastError === "string" ? { lastError: v.lastError } : {}),
  }
}

function isPRProviderId(v: unknown): v is TaskPRStatus["provider"] {
  return v === "github" || v === "gitlab" || v === "bitbucket" || v === "unknown"
}

function isPRLifecycleState(v: unknown): v is TaskPRStatus["lifecycle"] {
  return (
    v === "creating" || v === "open" || v === "ready_to_merge" || v === "merged" || v === "closed" || v === "unknown"
  )
}

function isPRCheckState(v: unknown): v is TaskPRStatus["checkState"] {
  return v === "none" || v === "pending" || v === "passing" || v === "failing" || v === "unknown"
}

function isTaskStatus(s: string): s is TaskStatus {
  return (
    s === "backlog" || s === "in_progress" || s === "in_review" || s === "done" || s === "canceled" || s === "error"
  )
}
