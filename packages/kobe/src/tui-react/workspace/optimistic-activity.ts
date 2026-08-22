/**
 * Optimistic sidebar-activity overlay — kobe hosts the engine terminal, so
 * the keystroke that triggers or interrupts a turn is visible LOCALLY long
 * before the hook→daemon→channel round trip confirms it.
 *
 * The two marks are deliberately NOT symmetric, because they are different
 * kinds of claim:
 *
 * - `running` (enter) is a GUESS ABOUT THE FUTURE — "a turn is probably
 *   starting". It expires on a short TTL, so enter on an empty composer
 *   self-heals with no correcting event.
 * - `interrupted` (esc) is a FACT ABOUT THE PAST — "at time T the user
 *   interrupted". Every authoritative state stamped BEFORE T is therefore
 *   stale evidence, and stays suppressed until a genuinely newer event
 *   arrives. It never decays back into the old state; its TTL is only a
 *   memory bound.
 *
 * That asymmetry is what kills the recurring class of bug: an engine that
 * never reports a terminal state (esc during `/compact` sends no
 * post-compact and no Stop hook) used to leave a `running` entry that
 * resurfaced the moment any suppression expired.
 *
 * No label text is ever derived from a mark — this feeds the ICON only.
 */

import type { TaskEngineState } from "../../client/remote-orchestrator-payloads"
import { createStateCell } from "../../lib/external-store"

export type OptimisticMark = { readonly kind: "running" | "interrupted"; readonly at: number }

/** Enter-guess lifetime: hooks usually confirm in <1s; decay if they never do. */
const RUNNING_TTL_MS = 5_000
/**
 * Answering a QUESTION is the exception to the short guess TTL.
 *
 * A permission prompt that gets approved ends its turn, so `Stop` arrives and
 * clears the badge. An AskUserQuestion dialog does not: answering it resumes
 * the SAME turn, so no `Stop`, no `UserPromptSubmit` — no event at all — while
 * `permission_needed` is deliberately sticky (the lapse watchdog must not idle
 * a task that genuinely needs a human). Nothing then clears it, and the `?`
 * pins forever on a tab whose engine is already working again.
 *
 * So an enter typed AT a `permission_needed` tab is treated as a fact about
 * the past ("the user answered at time T"), not a 5s guess: it suppresses that
 * stale state until a genuinely newer event supersedes it.
 */
const ANSWERED_TTL_MS = 30 * 60_000
/** Esc-fact lifetime: correctness comes from supersession, this is just a
 *  memory bound so a long-lived pane can't accumulate marks forever. */
const INTERRUPTED_TTL_MS = 30 * 60_000

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
  if (pruneTimer) clearTimeout(pruneTimer)
  pruneTimer = setTimeout(prune, RUNNING_TTL_MS + 20)
}

/** Drop a task's mark — an authoritative event superseded it. */
export function clearOptimisticMark(taskId: string): void {
  if (!cell.get().has(taskId)) return
  const next = new Map(cell.get())
  next.delete(taskId)
  cell.set(next)
}

/**
 * Feed one raw input write from an ENGINE tab's terminal. Enter (a lone
 * `\r` or a paste ending in one) reads as "turn triggered"; a bare esc
 * byte reads as "turn interrupted". Everything else is ignored — note the
 * bare-`\x1b` test excludes arrow keys and other CSI sequences.
 */
export function noteEngineInput(taskId: string, data: string): void {
  if (data === "\r" || data.endsWith("\r")) put(taskId, "running")
  else if (data === "\x1b") put(taskId, "interrupted")
}

/**
 * Per-TAB answer marks. Separate from the task-level cell on purpose: the
 * task entry is a last-event-wins rollup, so a sibling tab's activity already
 * moves it off `permission_needed` — the badge that strands is the TAB's, and
 * the task-level overlay cannot reach it. Keyed `taskId::tabId`.
 */
const answered = createStateCell<ReadonlyMap<string, number>>(new Map())

export const answeredTabsStore = answered

const tabKey = (taskId: string, tabId: string): string => `${taskId}::${tabId}`

/**
 * The user pressed enter in a tab whose engine was waiting on them. Records
 * WHEN, so any activity the daemon stamped before that moment reads as stale.
 * Only call this when the tab actually shows `permission_needed` — an enter at
 * an idle tab is an ordinary prompt submit and must not suppress anything.
 */
export function noteQuestionAnswered(taskId: string, tabId: string): void {
  const next = new Map(answered.get())
  next.set(tabKey(taskId, tabId), Date.now())
  answered.set(next)
}

/**
 * One raw write from an engine tab's terminal, routed to both overlays:
 * always the task-level enter/esc guess, plus the per-tab answer mark when
 * this tab is the one waiting on the user.
 */
export function noteEngineTabInput(data: string, taskId: string, tabId: string, tabState?: string): void {
  noteEngineInput(taskId, data)
  if ((data === "\r" || data.endsWith("\r")) && tabState === "permission_needed") {
    noteQuestionAnswered(taskId, tabId)
  }
}

/**
 * Drop `permission_needed` from a tab the user has since answered, until the
 * daemon reports something stamped after the answer. Pure.
 *
 * Deliberately narrow: it suppresses ONLY `permission_needed`, and only on the
 * exact tab that was answered. Every other state, and every other tab, passes
 * through untouched — a local guess must never be able to hide a real error or
 * rate-limit badge.
 */
export function mergeAnsweredTabs(
  tabs: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>,
  marks: ReadonlyMap<string, number>,
  now: number = Date.now(),
): ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>> {
  if (marks.size === 0) return tabs
  let out: Map<string, ReadonlyMap<string, TaskEngineState>> | null = null
  for (const [key, at] of marks) {
    if (now - at > ANSWERED_TTL_MS) continue
    const sep = key.lastIndexOf("::")
    if (sep === -1) continue
    const taskId = key.slice(0, sep)
    const tabId = key.slice(sep + 2)
    const perTab = (out ?? tabs).get(taskId)
    const entry = perTab?.get(tabId)
    if (entry?.state !== "permission_needed" || entry.at >= at) continue
    const nextTabs = new Map(perTab)
    nextTabs.delete(tabId)
    out ??= new Map(tabs)
    if (nextTabs.size > 0) out.set(taskId, nextTabs)
    else out.delete(taskId)
  }
  return out ?? tabs
}

/** Answer marks the daemon has superseded — the host drops these so the
 *  overlay stays self-cleaning rather than a second source of truth. */
export function supersededAnswers(
  tabs: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>,
  marks: ReadonlyMap<string, number>,
  now: number = Date.now(),
): readonly string[] {
  const done: string[] = []
  for (const [key, at] of marks) {
    if (now - at > ANSWERED_TTL_MS) {
      done.push(key)
      continue
    }
    const sep = key.lastIndexOf("::")
    if (sep === -1) continue
    const entry = tabs.get(key.slice(0, sep))?.get(key.slice(sep + 2))
    if (entry === undefined || entry.at >= at) done.push(key)
  }
  return done
}

/** Drop answer marks by key. */
export function clearAnsweredTabs(keys: readonly string[]): void {
  if (keys.length === 0) return
  const next = new Map(answered.get())
  for (const k of keys) next.delete(k)
  answered.set(next)
}

/** Test/HMR hook: drop every mark. */
export function resetOptimisticActivity(): void {
  if (pruneTimer) clearTimeout(pruneTimer)
  pruneTimer = null
  cell.set(new Map())
  answered.set(new Map())
}

/**
 * Overlay the marks onto the authoritative activity map (pure — the
 * sidebar feed goes through this).
 *
 * - An authoritative event stamped at/after the mark ALWAYS wins (and the
 *   caller may then drop that mark via {@link clearOptimisticMark}).
 * - `running`: an unexpired mark spins a task the daemon hasn't caught up on.
 * - `interrupted`: suppresses any activity older than the interrupt, for as
 *   long as the mark lives — stale state cannot come back.
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
    // Newer (or same-instant) authority always wins over a local guess.
    if (authoritative && authoritative.at >= mark.at) continue
    if (mark.kind === "running") {
      if (authoritative?.state === "running") continue
      out ??= new Map(auth)
      out.set(taskId, { state: "running", at: mark.at })
    } else if (authoritative !== undefined) {
      // Everything the daemon knew about this task predates the interrupt.
      out ??= new Map(auth)
      out.delete(taskId)
    }
  }
  return out ?? auth
}

/**
 * Marks the given authoritative map has superseded (an event at/after the
 * mark). The host drops these so the overlay stays a thin, self-cleaning
 * layer rather than a second source of truth.
 */
export function supersededMarks(
  auth: ReadonlyMap<string, TaskEngineState>,
  marks: ReadonlyMap<string, OptimisticMark>,
): readonly string[] {
  if (marks.size === 0) return []
  const done: string[] = []
  for (const [taskId, mark] of marks) {
    const authoritative = auth.get(taskId)
    if (authoritative && authoritative.at >= mark.at) done.push(taskId)
  }
  return done
}
