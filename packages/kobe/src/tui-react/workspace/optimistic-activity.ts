/**
 * Optimistic sidebar-activity overlay — kobe hosts the engine terminal, so
 * the keystroke that triggers or interrupts a turn is visible LOCALLY long
 * before the hook→daemon→channel round trip confirms it. Enter in an
 * engine tab marks the task optimistically running (spinner starts on the
 * keypress, not ~1s later); bare esc marks it interrupted (spinner stops
 * on the keypress instead of waiting out idle detection).
 *
 * Marks are GUESSES and behave like guesses: authoritative engine-state
 * events with a newer timestamp win at merge time, and every mark decays
 * on a short TTL so a wrong guess (enter on an empty composer, esc that
 * only closed a menu) self-heals without any correcting event. No label
 * text is ever derived from a mark — this feeds the ICON only.
 */

import type { TaskEngineState } from "../../client/remote-orchestrator-payloads"
import { createStateCell } from "../../lib/external-store"

export type OptimisticMark = { readonly kind: "running" | "interrupted"; readonly at: number }

/** Enter-guess lifetime: hooks usually confirm in <1s; decay if they never do. */
const RUNNING_TTL_MS = 5_000
/** Esc-guess lifetime: idle detection normally lands within this window. */
const INTERRUPTED_TTL_MS = 4_000

const cell = createStateCell<ReadonlyMap<string, OptimisticMark>>(new Map())
let pruneTimer: ReturnType<typeof setTimeout> | null = null

/** The overlay store — `useAccessor(optimisticActivityStore)` in the host. */
export const optimisticActivityStore = cell

function ttlFor(mark: OptimisticMark): number {
  return mark.kind === "running" ? RUNNING_TTL_MS : INTERRUPTED_TTL_MS
}

function prune(): void {
  pruneTimer = null
  const now = Date.now()
  let next: Map<string, OptimisticMark> | null = null
  let soonest = Number.POSITIVE_INFINITY
  for (const [taskId, mark] of cell.get()) {
    const expiresAt = mark.at + ttlFor(mark)
    if (expiresAt <= now) {
      next ??= new Map(cell.get())
      next.delete(taskId)
    } else if (expiresAt < soonest) soonest = expiresAt
  }
  if (next) cell.set(next)
  if (soonest < Number.POSITIVE_INFINITY) pruneTimer = setTimeout(prune, soonest - now + 20)
}

function put(taskId: string, kind: OptimisticMark["kind"]): void {
  const next = new Map(cell.get())
  next.set(taskId, { kind, at: Date.now() })
  cell.set(next)
  if (!pruneTimer) pruneTimer = setTimeout(prune, (kind === "running" ? RUNNING_TTL_MS : INTERRUPTED_TTL_MS) + 20)
}

/**
 * Feed one raw input write from an ENGINE tab's terminal. Enter (a lone
 * `\r` or a paste ending in one) reads as "turn triggered"; a bare esc
 * byte reads as "turn interrupted". Everything else is ignored.
 */
export function noteEngineInput(taskId: string, data: string): void {
  if (data === "\r" || data.endsWith("\r")) put(taskId, "running")
  else if (data === "\x1b") put(taskId, "interrupted")
}

/** Test/HMR hook: drop every mark. */
export function resetOptimisticActivity(): void {
  if (pruneTimer) clearTimeout(pruneTimer)
  pruneTimer = null
  cell.set(new Map())
}

/**
 * Overlay the marks onto the authoritative activity map (pure — the
 * sidebar feed goes through this). Rules: an unexpired `running` mark
 * makes a non-running task spin; an unexpired `interrupted` mark silences
 * a running one; any authoritative event at or after the mark wins.
 */
export function mergeOptimisticActivity(
  auth: ReadonlyMap<string, TaskEngineState>,
  marks: ReadonlyMap<string, OptimisticMark>,
  now: number = Date.now(),
): ReadonlyMap<string, TaskEngineState> {
  if (marks.size === 0) return auth
  let out: Map<string, TaskEngineState> | null = null
  for (const [taskId, mark] of marks) {
    if (now - mark.at > ttlFor(mark)) continue
    const authoritative = auth.get(taskId)
    if (authoritative && authoritative.at >= mark.at) continue
    if (mark.kind === "running") {
      if (authoritative?.state === "running") continue
      out ??= new Map(auth)
      out.set(taskId, { state: "running", at: mark.at })
    } else if (authoritative?.state === "running") {
      out ??= new Map(auth)
      out.delete(taskId)
    }
  }
  return out ?? auth
}
