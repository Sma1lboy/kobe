import type { PaneId } from "../context/focus"

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
}

/**
 * Every workspace-level chord group (help/focus/quit/task-lifecycle…) is
 * gated on this: no dialog AND no full-page swap open. The one deliberate
 * exemption in host-keybindings.ts is {@link settingsCloseKeysEnabled}.
 */
export function workspacePagesClosed(s: WorkspacePageState): boolean {
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

/**
 * The central ChatPane must never steal its own editing keys, while the
 * terminal must retain control chords it forwards to the child process.
 * Tasks and Files do not have that native-input conflict, so their controls
 * stay direct. Callers use this to select the direct or prefix half of a
 * dual-mode keymap row; it never changes the row's normal scope gate.
 */
export function bindingModeForPane(pane: PaneId): "direct" | "prefix" {
  return pane === "workspace" || pane === "terminal" ? "prefix" : "direct"
}

/** A dual-mode four-pane row receives prefix slots after its direct slots. */
export function focusSlotIndex(slot: number | undefined): number {
  return (slot ?? 0) % 4
}
