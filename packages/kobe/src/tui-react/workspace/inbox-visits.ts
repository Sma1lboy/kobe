/**
 * The Inbox's RECENT order — a real visit log, not `task.updatedAt`.
 *
 * `updatedAt` moves on ANY mutation (vendor change, status flip, PR-status
 * backfill), so sorting by it answers "what changed lately", while RECENT
 * has to answer "where was I lately". This records the visits themselves:
 * one entry per task (its LAST tab wins, so reopening the row lands you
 * exactly where you left), newest first, capped.
 *
 * Framework-free so the pane, the host, and unit tests share one rule; the
 * KV layer just persists the array.
 */

const VISITS_KEY = "inboxVisits"
const VISIT_LIMIT = 20

export type InboxVisit = {
  readonly taskId: string
  readonly tabId: string | null
  /** Visit time, epoch ms — the age the RECENT row shows. */
  readonly at: number
}

function isVisit(value: unknown): value is InboxVisit {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.taskId === "string" &&
    (candidate.tabId === null || typeof candidate.tabId === "string") &&
    typeof candidate.at === "number"
  )
}

/** Persisted visits are user-editable JSON — drop anything malformed. */
export function parseInboxVisits(stored: unknown): InboxVisit[] {
  if (!Array.isArray(stored)) return []
  return stored.filter(isVisit).slice(0, VISIT_LIMIT)
}

/**
 * Fold a visit into the log. One entry per task: revisiting a task moves it
 * to the front and adopts the tab you just landed on.
 */
export function recordInboxVisit(visits: readonly InboxVisit[], visit: InboxVisit, limit = VISIT_LIMIT): InboxVisit[] {
  const rest = visits.filter((entry) => entry.taskId !== visit.taskId)
  return [visit, ...rest].slice(0, limit)
}

/** Visit order by task id — position 0 is the most recent. */
export function inboxVisitIndex(visits: readonly InboxVisit[]): Map<string, InboxVisit> {
  const byTask = new Map<string, InboxVisit>()
  for (const visit of visits) if (!byTask.has(visit.taskId)) byTask.set(visit.taskId, visit)
  return byTask
}

type VisitKV = { get(key: string, defaultValue?: unknown): unknown; set(key: string, value: unknown): void }

export function readInboxVisits(kv: VisitKV): InboxVisit[] {
  return parseInboxVisits(kv.get(VISITS_KEY))
}

export function writeInboxVisit(kv: VisitKV, visit: InboxVisit): void {
  const visits = readInboxVisits(kv)
  const [previous] = visits
  // Already on top with the same tab: you never left, so there's nothing new
  // to record. Tab activation re-fires on every remount and this array is
  // persisted state — skipping keeps the arrival time honest AND the writes
  // rare. `at` therefore reads as "when you last came here".
  if (previous?.taskId === visit.taskId && previous.tabId === visit.tabId) return
  kv.set(VISITS_KEY, recordInboxVisit(visits, visit))
}
