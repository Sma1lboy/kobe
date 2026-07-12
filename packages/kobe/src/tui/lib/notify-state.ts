/**
 * Framework-free notification state (issue #15, G3) — the pure map
 * transforms + gating rules behind the per-ChatTab completion
 * notifications, shared by the Solid provider
 * (`src/tui/context/notifications.tsx`) and the React port
 * (`src/tui-react/context/notifications.tsx`). Keeping the escalation
 * rule ("needs_input / error outrank done") and the "error toasts always
 * show" invariant in one place means both runtimes can't drift.
 */

export type NotificationKind = "done" | "needs_input" | "error"

export interface Toast {
  readonly id: number
  readonly kind: NotificationKind
  readonly taskId: string
  readonly tabId: string
  readonly title: string
}

export interface NotifyInput {
  readonly kind: NotificationKind
  readonly taskId: string
  readonly tabId: string
  readonly title: string
}

export const TOAST_DURATION_MS = 4500

export function unreadKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

/**
 * Merge a notification into the unread map. Attention-demanding kinds
 * outrank `done` if both fire for the same key before the user clears it —
 * yellow (`needs_input`) / red (`error`) trump green. Returns `prev`
 * unchanged when the existing mark already outranks the new one.
 */
export function addUnread(
  prev: ReadonlyMap<string, NotificationKind>,
  input: NotifyInput,
): ReadonlyMap<string, NotificationKind> {
  const key = unreadKey(input.taskId, input.tabId)
  const existing = prev.get(key)
  if (existing === "needs_input" || existing === "error") return prev
  const next = new Map(prev)
  next.set(key, input.kind)
  return next
}

/** Clear the unread mark for a (task, tab). Returns `prev` when absent. */
export function removeUnread(
  prev: ReadonlyMap<string, NotificationKind>,
  taskId: string,
  tabId: string,
): ReadonlyMap<string, NotificationKind> {
  const key = unreadKey(taskId, tabId)
  if (!prev.has(key)) return prev
  const next = new Map(prev)
  next.delete(key)
  return next
}

/**
 * Toast gate. `error` always shows: error toasts are failure feedback and
 * must not vanish into the daemon log when the user disables the
 * completion "Toast" preference — that's a silent-failure regression.
 */
export function shouldShowToast(kind: NotificationKind, toastEnabled: boolean): boolean {
  return kind === "error" || toastEnabled
}

/**
 * Cross-task attention (WorkspaceRoot rising-edge notify). The daemon's
 * `TaskActivityState` is engine-normalized (no vendor strings); we map the
 * three attention-worthy transitions to a {@link NotificationKind} and treat
 * everything else as "no notification". A `null` return means "don't notify".
 * `permission_needed` → `needs_input` (yellow), `error` → `error` (red), and
 * `turn_complete` → `done` (green). Kept as a string→string map so the caller
 * (which owns the daemon state type) doesn't import the notify enum names.
 */
export function attentionKindFor(state: string): NotificationKind | null {
  if (state === "permission_needed") return "needs_input"
  if (state === "error") return "error"
  if (state === "turn_complete") return "done"
  return null
}

/**
 * OSC 9 desktop-notification escape. iTerm2 / kitty / WezTerm / Ghostty render
 * it as a native OS notification; every other terminal ignores an unknown OSC
 * silently. Zero deps, and — crucially — it travels down the SSH stream to the
 * user's LOCAL terminal, unlike an `afplay` chime that rings on the remote box.
 * Body is BEL-terminated (`\x07`), the widely-accepted OSC terminator.
 */
export function osc9(body: string): string {
  return `\x1b]9;${body}\x07`
}

/** One F7 stop: a task, optionally a specific engine tab to activate. */
export interface AttentionTarget {
  readonly taskId: string
  readonly tabId: string | null
}

/** States that BLOCK the engine on the user — raw daemon state is the truth
 *  and the candidacy persists until the user actually acts (approving /
 *  answering emits the next hook event, which clears it). */
function isBlockingState(state: string | undefined): boolean {
  return state === "permission_needed" || state === "error"
}

/** Stable within-task tab order: by trailing ordinal (`tab-3`), then name. */
function compareTabIds(a: string, b: string): number {
  const na = Number(a.split("-").pop())
  const nb = Number(b.split("-").pop())
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a.localeCompare(b)
}

/**
 * Attention-jump cycle (the global chord). Candidates are (task, tab) pairs,
 * walked in sidebar order × tab order, forward from the current position and
 * wrapping — so repeated presses visit every waiting tab of every task,
 * including the OTHER tabs of the task you're on. `null` when nothing waits.
 *
 * A pair qualifies via two mechanisms with different lifetimes:
 *   - BLOCKING raw state (`permission_needed` — a permission prompt or a
 *     question dialog — or `error`): persists until the user acts. Per-tab
 *     when the hook carried a tab identity, else task-level.
 *   - UNREAD marks (`needs_input` / `error` / `done`): rising edges the user
 *     hasn't looked at — this is how `turn_complete` is navigable without
 *     looping forever. The jump handler marks the target read on arrival, so
 *     visited completions drop out of the cycle.
 * A task qualifying only at task level still refines to a concrete tab when
 * the per-tab map knows one in an attention-worthy state.
 */
export function nextAttentionTarget(
  order: readonly string[],
  engineState: ReadonlyMap<string, { readonly state: string }>,
  tabStates: ReadonlyMap<string, ReadonlyMap<string, { readonly state: string }>>,
  unread: ReadonlyMap<string, NotificationKind>,
  current: { readonly taskId: string | null; readonly tabId: string | null },
): AttentionTarget | null {
  // unread keys are `${taskId}:${tabId}` (tabId "" = a task-level mark).
  const unreadTabsByTask = new Map<string, Set<string>>()
  for (const [key, kind] of unread) {
    if (kind !== "needs_input" && kind !== "error" && kind !== "done") continue
    const sep = key.indexOf(":")
    const taskId = sep === -1 ? key : key.slice(0, sep)
    const tabId = sep === -1 ? "" : key.slice(sep + 1)
    const set = unreadTabsByTask.get(taskId) ?? new Set<string>()
    set.add(tabId)
    unreadTabsByTask.set(taskId, set)
  }

  const candidatesFor = (taskId: string): readonly (string | null)[] => {
    const tabs = tabStates.get(taskId)
    const marks = unreadTabsByTask.get(taskId)
    const out = new Set<string>()
    if (tabs) {
      for (const [tabId, s] of tabs) if (isBlockingState(s.state)) out.add(tabId)
    }
    if (marks) for (const tabId of marks) if (tabId !== "") out.add(tabId)
    if (out.size > 0) return [...out].sort(compareTabIds)
    // No tab-precise candidate — does the task qualify at task level?
    if (!isBlockingState(engineState.get(taskId)?.state) && !marks) return []
    // Refine a task-level hit to a concrete tab when the per-tab map knows
    // one sitting in an attention-worthy state (e.g. the tab whose turn just
    // completed). Raw turn_complete is only a REFINEMENT, never a candidacy
    // source — otherwise a visited completion would cycle forever.
    if (tabs) {
      const refined = [...tabs.entries()]
        .filter(([, s]) => isBlockingState(s.state) || s.state === "turn_complete")
        .map(([tabId]) => tabId)
        .sort(compareTabIds)
      if (refined.length > 0) return [refined[0] as string]
    }
    return [null]
  }

  const flat: AttentionTarget[] = []
  for (const taskId of order) {
    for (const tabId of candidatesFor(taskId)) {
      // Sitting on the task already: a task-level (null-tab) self-target is a
      // no-op jump — skip it; concrete OTHER tabs of the current task stay.
      if (taskId === current.taskId && (tabId === null || tabId === current.tabId)) continue
      flat.push({ taskId, tabId })
    }
  }
  if (flat.length === 0) return null

  // Forward from the current position: entries of the current task (its
  // other waiting tabs) sort first in the walk, then tasks after it in
  // sidebar order, wrapping.
  const curOrder = current.taskId ? order.indexOf(current.taskId) : -1
  const rank = (t: AttentionTarget): number => {
    const i = order.indexOf(t.taskId)
    if (i === curOrder) return 0 // current task's other tabs come first
    return i > curOrder ? i - curOrder : order.length + (i - curOrder)
  }
  flat.sort((a, b) => rank(a) - rank(b))
  return flat[0] ?? null
}
