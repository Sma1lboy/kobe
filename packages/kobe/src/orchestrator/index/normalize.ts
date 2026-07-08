/**
 * Pure load-side helpers for the task index: version constant, corrupt-file
 * backup, and the JSON → v3 {@link Task} coercion/normalization.
 *
 * These are the stateless half of `store.ts` — no cache, no listeners, no I/O
 * beyond the best-effort corrupt-file backup. Keeping them here lets the store
 * class stay focused on the read-merge-write lifecycle (and keeps both files
 * under the size cap).
 */

import { writeFile } from "node:fs/promises"
import type { Task, TaskPRStatus, TaskStatus } from "../../types/task.ts"
import { toTaskId } from "../../types/task.ts"
import { coerceVendorId } from "../../types/vendor.ts"

/** Current on-disk manifest version. Older v1/v2 shapes migrate on load. */
export const CURRENT_VERSION = 3 as const

/** A normalized in-memory index: the v3 version tag plus the coerced task rows. */
export type NormalizedIndex = { version: typeof CURRENT_VERSION; tasks: Task[] }

/**
 * Preserve the bytes of an unparseable manifest before recovery overwrites it.
 * `TaskIndexStore.load` recovers a corrupt `tasks.json` as an empty index and
 * hands the UI a clean slate immediately — but the next `save()` rewrites
 * `tasks.json` from that empty base, permanently destroying whatever task rows
 * the corrupt file still held. Copying the raw bytes to a timestamped
 * `tasks.json.corrupt-*` sibling makes that data recoverable by hand.
 *
 * Best-effort by design: a failed backup logs and returns `null` rather than
 * throwing — a corrupt manifest must never wedge boot, which is the whole point
 * of the recover-to-empty policy. Returns the backup path on success.
 */
export async function backupCorruptManifest(manifestPath: string, raw: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/:/g, "-")
  const backupPath = `${manifestPath}.corrupt-${stamp}`
  try {
    await writeFile(backupPath, raw, "utf8")
    return backupPath
  } catch (err) {
    console.warn(`[kobe] could not back up corrupt tasks.json to ${backupPath}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Normalize an arbitrary JSON value into a v3 cache. Migrates v1 / v2
 * manifests by stripping the dropped fields (`tabs`, `activeTabId`,
 * `sessionId`, `model`, `modelEffort`, `permissionMode`). The first
 * save after load persists the v3 shape.
 */
export function normalizeIndex(parsed: unknown, source: string): NormalizedIndex {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[kobe] tasks.json at ${source} is not an object; recovering with empty index.`)
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const obj = parsed as { version?: unknown; tasks?: unknown }
  const version = obj.version
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    console.warn(
      `[kobe] tasks.json at ${source} has unsupported version=${String(version)}; recovering with empty index.`,
    )
    return { version: CURRENT_VERSION, tasks: [] }
  }

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks: Task[] = []
  for (const entry of rawTasks) {
    const task = coerceTask(entry)
    if (task) tasks.push(task)
    else {
      console.warn(`[kobe] dropping malformed task entry from ${source}: ${JSON.stringify(entry)}`)
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
  const kind: Task["kind"] = v.kind === "main" ? "main" : "task"
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
    vendor: coerceVendorId(typeof v.vendor === "string" ? v.vendor : undefined),
    prStatus: coercePRStatus(v.prStatus),
    // Web-board ordering key — must survive the load coercion or every
    // daemon restart silently forgets the user's column order.
    ...(typeof v.position === "number" && Number.isFinite(v.position) ? { position: v.position } : {}),
    // Engine reasoning/effort level — must survive the load coercion or the
    // task forgets its effort on every daemon restart.
    ...(typeof v.modelEffort === "string" && v.modelEffort.length > 0 ? { modelEffort: v.modelEffort } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
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
