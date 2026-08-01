/**
 * Pure gating predicates for the workspace host's keybindings
 * (host-keybindings.ts). Framework-free on purpose: vitest can import this
 * without pulling in `@opentui/react`, so the "an open dialog/page disables
 * workspace chords" contract is pinned by a unit test instead of living as
 * scattered inline boolean expressions.
 *
 * Note the ModalBarrier (ui/dialog.tsx) already cuts dialog-open keys off
 * structurally; `dialogOpen` here is defense in depth for dialogs and the
 * ONLY gate for the full-page swaps (settings/worktrees/update), which are
 * not dialogs and mount no barrier.
 */

export type WorkspacePageState = {
  /** `dialog.stack.length > 0` — any dialog up on the shared stack. */
  dialogOpen: boolean
  settingsOpen: boolean
  worktreesOpen: boolean
  updateOpen: boolean
  /**
   * The sidebar-rail pages. Deliberately NOT part of
   * {@link workspacePagesClosed}: they replace only the content pane, so the
   * sidebar and its chords stay live behind them — including the prefix
   * itself, which is how you switch from one rail page to another (or back)
   * without pressing esc first.
   */
  kanbanOpen: boolean
  automationsOpen: boolean
  workItemsOpen: boolean
}

/**
 * Every workspace-level chord group (help/focus/quit/task-lifecycle…) is
 * gated on this: no dialog AND no full-page swap open. The one deliberate
 * exemption in host-keybindings.ts is {@link settingsCloseKeysEnabled}.
 */
export function workspacePagesClosed(s: WorkspacePageState): boolean {
  // Only the FULL-WINDOW surfaces gate the chords: they cover the sidebar, so
  // a sidebar chord would act on something the user cannot see. A rail page
  // leaves the sidebar visible and must not disable it.
  return !s.dialogOpen && !s.settingsOpen && !s.worktreesOpen && !s.updateOpen
}

/**
 * The settings page's own close keys (esc/q/ctrl+c) — deliberately exempt
 * from {@link workspacePagesClosed}: they are live exactly BECAUSE the
 * settings page is open, but yield to any sub-dialog above it (e.g. the
 * engine-command editor needs esc + typed keys for itself).
 */
export function settingsCloseKeysEnabled(s: WorkspacePageState): boolean {
  return s.settingsOpen && !s.dialogOpen
}

/** Focus cycle order: sidebar ← workspace → files. */
export const PANE_CYCLE = ["sidebar", "workspace", "files"] as const
export type CyclePaneId = (typeof PANE_CYCLE)[number]

/**
 * Where focus lands after a cycle step, given which panes are mounted.
 *
 * The files pane is not always there — zen hides it, and so does any rail
 * page (a page reads daemon state, not a worktree's files). Focusing an
 * unmounted pane strands the cursor on nothing, so it drops out of the cycle
 * rather than being clamped against.
 *
 * Cursor semantics, not a ring (owner call 2026-07-25): movement clamps at
 * both ends instead of wrapping, so "previous" from the sidebar never jumps
 * to files. Returns null when focus should not move.
 */
export function nextFocusedPane(current: string, delta: 1 | -1, opts: { filesVisible: boolean }): CyclePaneId | null {
  const reachable = PANE_CYCLE.filter((pane) => pane !== "files" || opts.filesVisible)
  const idx = reachable.indexOf(current as CyclePaneId)
  // Focus is on a pane that just vanished under the cursor — step to the
  // nearest end instead of acting on an index of -1.
  if (idx < 0) return (delta > 0 ? reachable[reachable.length - 1] : reachable[0]) ?? null
  const next = Math.min(Math.max(idx + delta, 0), reachable.length - 1)
  return next === idx ? null : ((reachable[next] as CyclePaneId) ?? null)
}
