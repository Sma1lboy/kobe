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
  /** Optional context line under the title (task title, project…). */
  readonly body?: string
}

export interface NotifyInput {
  readonly kind: NotificationKind
  readonly taskId: string
  readonly tabId: string
  readonly title: string
  /** Optional context line under the title (task title, project…). */
  readonly body?: string
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
 * Tab-chip vocabulary (`ChatTabTurnState`) → notification kind. The chip
 * sibling of {@link attentionKindFor}: `done`/`error`/`needs_input` notify,
 * everything else (idle/running/unknown) is not an attention edge. String→
 * string for the same reason.
 */
export function chipAttentionKind(turn: string): NotificationKind | null {
  if (turn === "done") return "done"
  if (turn === "error") return "error"
  if (turn === "needs_input") return "needs_input"
  return null
}

/**
 * Rising-edge detector shared by both notifiers (the ONE notification
 * module's core). Diffs `prev` → `next` and returns the keys whose value
 * transitioned INTO an attention state, per `kindFor`. Two rules, both
 * load-bearing:
 *
 *  - Seed: `prev === null` (first observation, or a fresh subscribe whose
 *    replay includes sticky states like `turn_complete`) returns [] — the
 *    caller seeds its prev map and must NOT re-fire toasts for replayed
 *    history. Mirrors `use-attention.ts`'s original prevStates convention.
 *  - Edge: an unchanged value never notifies; only a transition does.
 *
 * `skip` excludes the key whose state is already on screen (the selected
 * task for the task-level notifier, the active tab for the tab-level one) —
 * the disjointness that makes double-toasting impossible by construction.
 */
export function attentionEdges(
  prev: ReadonlyMap<string, string> | null,
  next: ReadonlyMap<string, string>,
  skip: string | null,
  kindFor: (state: string) => NotificationKind | null,
): readonly { key: string; kind: NotificationKind }[] {
  if (prev === null) return []
  const out: { key: string; kind: NotificationKind }[] = []
  for (const [key, state] of next) {
    if (key === skip) continue
    if (prev.get(key) === state) continue
    const kind = kindFor(state)
    if (kind) out.push({ key, kind })
  }
  return out
}

/**
 * OSC 9 desktop-notification escape. iTerm2 / kitty / WezTerm / Ghostty render
 * it as a native OS notification; every other terminal ignores an unknown OSC
 * silently. Zero deps, and — crucially — it travels down the SSH stream to the
 * user's LOCAL terminal, unlike an `afplay` chime that rings on the remote box.
 * Body is BEL-terminated (`\x07`), the widely-accepted OSC terminator.
 */
function sanitizeOscBody(body: string): string {
  let out = ""
  let segmentStart = 0
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) continue
    out += `${body.slice(segmentStart, i)} `
    segmentStart = i + 1
  }
  return segmentStart === 0 ? body : out + body.slice(segmentStart)
}

export function osc9(body: string): string {
  return `\x1b]9;${sanitizeOscBody(body)}\x07`
}
