/**
 * The Inbox's RECENT order — a real visit log, not `task.updatedAt`.
 *
 * `updatedAt` moves on ANY mutation (vendor change, status flip, PR-status
 * backfill), so sorting by it answers "what changed lately", while RECENT
 * has to answer "where was I lately". This records the visits themselves:
 * one entry per (task, TAB), newest first, capped.
 *
 * Per-tab, not per-task (owner report 2026-08-10): switching among a task's
 * chat tabs is the most common way to move around, and a task-keyed log
 * collapsed all of it into one entry — so the tabs you just left never
 * showed up and RECENT listed unrelated tasks instead.
 *
 * Framework-free so the pane, the host, and unit tests share one rule; the
 * KV layer just persists the array.
 */

const VISITS_KEY = "inboxVisits"
// Entries are per-tab now, so the same span of history costs more rows than
// it did when the log was task-keyed.
const VISIT_LIMIT = 60

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

/** Identity of a visit target — the (task, tab) pair a RECENT row opens. */
export function inboxVisitKey(visit: Pick<InboxVisit, "taskId" | "tabId">): string {
  return `${visit.taskId}\0${visit.tabId ?? ""}`
}

/**
 * Fold a visit into the log. One entry per (task, tab): revisiting a tab
 * moves it to the front, and a task's other tabs keep their own entries.
 */
export function recordInboxVisit(visits: readonly InboxVisit[], visit: InboxVisit, limit = VISIT_LIMIT): InboxVisit[] {
  const key = inboxVisitKey(visit)
  const rest = visits.filter((entry) => inboxVisitKey(entry) !== key)
  return [visit, ...rest].slice(0, limit)
}

/** Visits newest-first, deduped by (task, tab) — position 0 is the most recent. */
export function inboxVisitIndex(visits: readonly InboxVisit[]): Map<string, InboxVisit> {
  const byTarget = new Map<string, InboxVisit>()
  for (const visit of visits) {
    const key = inboxVisitKey(visit)
    if (!byTarget.has(key)) byTarget.set(key, visit)
  }
  return byTarget
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
